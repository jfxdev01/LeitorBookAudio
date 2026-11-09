// Visualizador de PDF com rolagem contínua, renderização sob demanda,
// camada de texto selecionável e camadas de destaque (frase, palavra, busca).

import { pdfjsLib } from './pdf-doc.js';

const MAX_CANVAS_PIXELS = 16_000_000;
const KEEP_RENDERED = 14;
const PAGE_GAP = 18;
const VIEWER_PADDING = 48;
const MAX_FIT_WIDTH = 1040;

function mergeRects(rects) {
  const sorted = rects.slice().sort((a, b) => (Math.abs(a.y - b.y) < 2 ? a.x - b.x : a.y - b.y));
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last) {
      const overlapY = Math.min(last.y + last.h, r.y + r.h) - Math.max(last.y, r.y);
      const sameLine = overlapY > Math.min(last.h, r.h) * 0.5;
      const gapX = r.x - (last.x + last.w);
      if (sameLine && gapX < Math.max(last.h, r.h) * 0.8 && gapX > -last.w) {
        const x = Math.min(last.x, r.x);
        const y = Math.min(last.y, r.y);
        last.w = Math.max(last.x + last.w, r.x + r.w) - x;
        last.h = Math.max(last.y + last.h, r.y + r.h) - y;
        last.x = x;
        last.y = y;
        continue;
      }
    }
    out.push({ ...r });
  }
  return out;
}

export class PdfViewer extends EventTarget {
  constructor(container, viewerEl, bookText) {
    super();
    this.container = container;
    this.viewerEl = viewerEl;
    this.bookText = bookText;
    this.pdf = bookText.pdf;
    this.pages = [];
    this.scale = 1;
    this.zoomMode = 'width'; // 'width' | 'page' | 'custom'
    this.highlights = { search: [], searchActive: [], sentence: [], word: [], flash: [] };
    this.currentPage = 1;
    this.rendered = new Set();
    this.destroyed = false;
    this._scrollRaf = 0;
    this._renderQueue = Promise.resolve();
    this._pendingReveal = null;

    this._onScroll = () => {
      if (this._scrollRaf) return;
      this._scrollRaf = requestAnimationFrame(() => {
        this._scrollRaf = 0;
        this._updateCurrentPage();
      });
    };
    this._onResize = () => {
      if (this.zoomMode !== 'custom') this._applyScale(this._fitScale(), true);
    };
    container.addEventListener('scroll', this._onScroll, { passive: true });
    this._resizeObserver = new ResizeObserver(() => {
      clearTimeout(this._resizeTimer);
      this._resizeTimer = setTimeout(this._onResize, 120);
    });
    this._resizeObserver.observe(container);
  }

  async init(initialPage = 1, zoom = null) {
    const first = await this.pdf.getPage(1);
    const vp = first.getViewport({ scale: 1 });
    this.defaultSize = { w: vp.width, h: vp.height };
    this.viewerEl.replaceChildren();
    this.pages = [];
    for (let n = 1; n <= this.pdf.numPages; n++) {
      const div = document.createElement('div');
      div.className = 'page';
      div.dataset.page = String(n);
      const num = document.createElement('div');
      num.className = 'page-number';
      num.textContent = String(n);
      div.append(num);
      this.viewerEl.append(div);
      this.pages.push({ num: n, div, size: n === 1 ? { w: vp.width, h: vp.height } : null, state: 'empty', renderTask: null, textLayer: null, textDivs: null, version: 0 });
    }
    if (zoom && zoom.mode) {
      this.zoomMode = zoom.mode;
      if (zoom.mode === 'custom' && zoom.scale) this.scale = zoom.scale;
    }
    this._applyScale(this.zoomMode === 'custom' ? this.scale : this._fitScale(), false);

    this._observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const pv = this.pages[Number(entry.target.dataset.page) - 1];
        pv.visible = entry.isIntersecting;
        if (entry.isIntersecting) this._queueRender(pv);
      }
    }, { root: this.container, rootMargin: '900px 0px' });
    this.pages.forEach((pv) => this._observer.observe(pv.div));

    this.goToPage(initialPage, { instant: true });
    this._loadSizesInBackground();
  }

  async _loadSizesInBackground() {
    // Obtém o tamanho real de cada página (livros com páginas de tamanhos diferentes).
    for (let n = 2; n <= this.pdf.numPages && !this.destroyed; n++) {
      const pv = this.pages[n - 1];
      if (pv.size) continue;
      try {
        const page = await this.pdf.getPage(n);
        const vp = page.getViewport({ scale: 1 });
        pv.size = { w: vp.width, h: vp.height };
        if (Math.abs(vp.width - this.defaultSize.w) > 1 || Math.abs(vp.height - this.defaultSize.h) > 1) {
          const anchor = this._scrollAnchor();
          this._sizePage(pv);
          this._restoreAnchor(anchor);
        }
      } catch { /* ignora */ }
      if (n % 25 === 0) await new Promise((r) => setTimeout(r, 0));
    }
  }

  _pageSize(pv) {
    return pv.size || this.defaultSize;
  }

  _fitScale() {
    // Em telas largas, limita a largura da página para manter linhas confortáveis de ler.
    const availW = Math.max(200, Math.min(this.container.clientWidth - VIEWER_PADDING - 16, MAX_FIT_WIDTH));
    const availH = Math.max(200, this.container.clientHeight - 40);
    const size = this._pageSize(this.pages[this.currentPage - 1] || this.pages[0]);
    if (this.zoomMode === 'page') return Math.min(availW / size.w, availH / size.h);
    return Math.min(availW / size.w, 3);
  }

  _sizePage(pv) {
    const size = this._pageSize(pv);
    pv.div.style.width = `${Math.floor(size.w * this.scale)}px`;
    pv.div.style.height = `${Math.floor(size.h * this.scale)}px`;
    pv.div.style.setProperty('--scale-factor', this.scale);
    pv.div.style.setProperty('--total-scale-factor', this.scale);
    pv.div.style.setProperty('--user-unit', '1');
  }

  _scrollAnchor() {
    const pv = this.pages[this.currentPage - 1];
    if (!pv) return null;
    const rel = (this.container.scrollTop - pv.div.offsetTop) / Math.max(1, pv.div.offsetHeight);
    return { page: this.currentPage, rel };
  }

  _restoreAnchor(anchor) {
    if (!anchor) return;
    const pv = this.pages[anchor.page - 1];
    this.container.scrollTop = pv.div.offsetTop + anchor.rel * pv.div.offsetHeight;
  }

  _applyScale(scale, keepPosition) {
    scale = Math.max(0.25, Math.min(5, scale));
    if (Math.abs(scale - this.scale) < 0.001 && this.pages[0]?.div.style.width) return;
    const anchor = keepPosition ? this._scrollAnchor() : null;
    this.scale = scale;
    for (const pv of this.pages) {
      this._sizePage(pv);
      if (pv.state !== 'empty') {
        pv.version++;
        pv.state = 'stale';
      }
    }
    if (anchor) this._restoreAnchor(anchor);
    for (const pv of this.pages) if (pv.visible && pv.state === 'stale') this._queueRender(pv);
    this.dispatchEvent(new CustomEvent('scalechange', { detail: { scale: this.scale, mode: this.zoomMode } }));
  }

  setZoom(mode, scale) {
    this.zoomMode = mode;
    if (mode === 'custom') this._applyScale(scale, true);
    else this._applyScale(this._fitScale(), true);
  }

  zoomBy(factor) {
    this.zoomMode = 'custom';
    this._applyScale(this.scale * factor, true);
  }

  _queueRender(pv) {
    if (pv.state === 'rendered' || pv.state === 'rendering') return;
    this._renderQueue = this._renderQueue.then(() => (pv.visible || pv.forceRender) && !this.destroyed ? this._render(pv) : null).catch((err) => console.error(err));
  }

  async _render(pv) {
    if (pv.state === 'rendered' || this.destroyed) return;
    const version = pv.version;
    pv.state = 'rendering';
    const page = await this.pdf.getPage(pv.num);
    if (!pv.size) {
      const vp1 = page.getViewport({ scale: 1 });
      pv.size = { w: vp1.width, h: vp1.height };
      this._sizePage(pv);
    }
    const viewport = page.getViewport({ scale: this.scale });
    let outputScale = window.devicePixelRatio || 1;
    const pixels = viewport.width * viewport.height * outputScale * outputScale;
    if (pixels > MAX_CANVAS_PIXELS) outputScale = Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height));

    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width * outputScale);
    canvas.height = Math.floor(viewport.height * outputScale);
    const ctx = canvas.getContext('2d', { alpha: false });
    const task = page.render({
      canvasContext: ctx,
      viewport,
      transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null
    });
    pv.renderTask = task;
    try {
      await task.promise;
    } catch (err) {
      if (err?.name !== 'RenderingCancelledException') console.error('Falha ao renderizar página', pv.num, err);
      if (pv.version === version) pv.state = 'empty';
      return;
    }
    if (pv.version !== version || this.destroyed) {
      pv.state = 'stale';
      if (pv.visible) this._queueRender(pv);
      return;
    }

    // Camada de texto (mesmos itens usados pelo modelo de frases).
    const pageText = await this.bookText.getPage(pv.num);
    const textLayerDiv = document.createElement('div');
    textLayerDiv.className = 'textLayer';
    const hlLayer = document.createElement('div');
    hlLayer.className = 'hl-layer';
    let textDivs = [];
    try {
      const tl = new pdfjsLib.TextLayer({ textContentSource: pageText.textContent, container: textLayerDiv, viewport });
      await tl.render();
      textDivs = tl.textDivs;
      const end = document.createElement('div');
      end.className = 'endOfContent';
      textLayerDiv.append(end);
    } catch (err) {
      console.warn('Camada de texto indisponível na página', pv.num, err);
    }
    if (pv.version !== version || this.destroyed) {
      pv.state = 'stale';
      if (pv.visible) this._queueRender(pv);
      return;
    }

    const number = pv.div.querySelector('.page-number');
    pv.div.replaceChildren(canvas, hlLayer, textLayerDiv, number);
    pv.canvas = canvas;
    pv.hlLayer = hlLayer;
    pv.textLayerDiv = textLayerDiv;
    pv.textDivs = textDivs;
    pv.pageText = pageText;
    pv.state = 'rendered';
    this.rendered.add(pv.num);
    this._drawHighlights(pv);
    this._evictFarPages();
    this.dispatchEvent(new CustomEvent('pagerendered', { detail: { page: pv.num } }));

    if (this._pendingReveal && this._pendingReveal.page === pv.num) {
      const pending = this._pendingReveal;
      this._pendingReveal = null;
      this.revealRanges(pending.ranges, pending.opts);
    }
  }

  _evictFarPages() {
    if (this.rendered.size <= KEEP_RENDERED) return;
    const far = [...this.rendered]
      .map((n) => this.pages[n - 1])
      .filter((pv) => !pv.visible)
      .sort((a, b) => Math.abs(b.num - this.currentPage) - Math.abs(a.num - this.currentPage));
    while (this.rendered.size > KEEP_RENDERED && far.length) {
      const pv = far.shift();
      const number = pv.div.querySelector('.page-number');
      pv.div.replaceChildren(number);
      pv.canvas = null;
      pv.textDivs = null;
      pv.hlLayer = null;
      pv.textLayerDiv = null;
      pv.state = 'empty';
      pv.version++;
      this.rendered.delete(pv.num);
    }
  }

  _updateCurrentPage() {
    const probe = this.container.scrollTop + this.container.clientHeight * 0.3;
    let lo = 0;
    let hi = this.pages.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.pages[mid].div.offsetTop <= probe) lo = mid; else hi = mid - 1;
    }
    const page = lo + 1;
    if (page !== this.currentPage) {
      this.currentPage = page;
      this.dispatchEvent(new CustomEvent('pagechange', { detail: { page } }));
    }
  }

  goToPage(n, { instant = false, offsetRatio = 0 } = {}) {
    const pv = this.pages[Math.max(1, Math.min(this.pages.length, n)) - 1];
    if (!pv) return;
    const top = pv.div.offsetTop - 12 + offsetRatio * pv.div.offsetHeight;
    this.container.scrollTo({ top, behavior: instant ? 'instant' : 'smooth' });
    if (instant) this._updateCurrentPage();
  }

  // ---------- Destaques ----------

  setHighlight(kind, ranges) {
    const prevPages = new Set((this.highlights[kind] || []).map((r) => r.page));
    this.highlights[kind] = ranges || [];
    const pages = new Set([...prevPages, ...this.highlights[kind].map((r) => r.page)]);
    for (const n of pages) {
      const pv = this.pages[n - 1];
      if (pv && pv.state === 'rendered') this._drawHighlights(pv);
    }
  }

  clearHighlights(...kinds) {
    for (const k of kinds) this.setHighlight(k, []);
  }

  _drawHighlights(pv) {
    if (!pv.hlLayer) return;
    pv.hlLayer.replaceChildren();
    const order = [['search', 'search'], ['searchActive', 'search active'], ['flash', 'flash'], ['sentence', 'sentence'], ['word', 'word']];
    for (const [kind, cls] of order) {
      for (const r of this.highlights[kind]) {
        if (r.page !== pv.num) continue;
        for (const rect of this.rangeRects(pv, r.start, r.end)) {
          const el = document.createElement('div');
          el.className = `hl-rect ${cls}`;
          const pad = kind === 'word' ? 1 : 2;
          el.style.left = `${rect.x - pad}px`;
          el.style.top = `${rect.y - pad / 2}px`;
          el.style.width = `${rect.w + pad * 2}px`;
          el.style.height = `${rect.h + pad}px`;
          pv.hlLayer.append(el);
        }
      }
    }
  }

  /** Retângulos (relativos à página) que cobrem o intervalo bruto [start, end). */
  rangeRects(pv, start, end) {
    const pt = pv.pageText;
    const divs = pv.textDivs;
    if (!pt || !divs || !divs.length) return [];
    let s = Math.max(0, start);
    let e = Math.min(end, pt.itemOf.length) - 1;
    while (s <= e && pt.itemOf[s] < 0) s++;
    while (e >= s && pt.itemOf[e] < 0) e--;
    if (s > e) return [];
    const i0 = pt.itemOf[s];
    const o0 = pt.offOf[s];
    const i1 = pt.itemOf[e];
    const o1 = pt.offOf[e] + 1;
    const base = pv.div.getBoundingClientRect();
    const range = document.createRange();
    const rects = [];
    for (let i = i0; i <= i1; i++) {
      const div = divs[i];
      if (!div || !div.isConnected) continue;
      const node = div.firstChild;
      if (!node || node.nodeType !== Node.TEXT_NODE) continue;
      const len = node.length;
      const a = i === i0 ? Math.min(o0, len) : 0;
      const b = i === i1 ? Math.min(o1, len) : len;
      if (b <= a) continue;
      range.setStart(node, a);
      range.setEnd(node, b);
      for (const r of range.getClientRects()) {
        if (r.width < 0.5 || r.height < 0.5) continue;
        rects.push({ x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height });
      }
    }
    return mergeRects(rects);
  }

  /**
   * Rola a visualização para mostrar os intervalos (se estiverem fora da área visível).
   * @param {Array<{page,start,end}>} ranges
   */
  revealRanges(ranges, { force = false, bottomInset = 0 } = {}) {
    if (!ranges?.length) return;
    const first = ranges[0];
    const pv = this.pages[first.page - 1];
    if (!pv) return;
    const viewTop = this.container.scrollTop;
    const viewH = this.container.clientHeight;
    if (pv.state !== 'rendered') {
      // Ainda não renderizada: vai até a página e completa quando ela aparecer.
      this._pendingReveal = { page: first.page, ranges, opts: { force: true, bottomInset } };
      const pt = this.bookText.pageTextSync(first.page);
      const ratio = pt && pt.raw.length ? first.start / pt.raw.length : 0;
      const top = pv.div.offsetTop + ratio * pv.div.offsetHeight - viewH * 0.3;
      this.container.scrollTo({ top: Math.max(0, top), behavior: 'instant' });
      pv.forceRender = true;
      this._queueRender(pv);
      return;
    }
    const rects = ranges.filter((r) => r.page === first.page).flatMap((r) => this.rangeRects(pv, r.start, r.end));
    if (!rects.length) return;
    const top = pv.div.offsetTop + Math.min(...rects.map((r) => r.y));
    const bottom = pv.div.offsetTop + Math.max(...rects.map((r) => r.y + r.h));
    const visibleTop = viewTop + 40;
    const visibleBottom = viewTop + viewH - 40 - bottomInset;
    if (force || top < visibleTop || bottom > visibleBottom) {
      const target = top - (viewH - bottomInset) * 0.32;
      this.container.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
    }
  }

  /** Converte um ponto da tela em (página, posição bruta) usando a camada de texto. */
  positionFromPoint(x, y) {
    const el = document.elementFromPoint(x, y);
    const pageDiv = el?.closest?.('.page');
    if (!pageDiv) return null;
    const pv = this.pages[Number(pageDiv.dataset.page) - 1];
    if (!pv || !pv.textDivs || !pv.pageText) return null;
    let span = null;
    let offset = 0;
    const caret = document.caretPositionFromPoint?.(x, y);
    if (caret && caret.offsetNode) {
      const node = caret.offsetNode;
      const parent = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
      if (parent && pv.textLayerDiv.contains(parent) && parent.tagName === 'SPAN') {
        span = parent;
        offset = caret.offset;
      }
    }
    if (!span) {
      // Procura o span mais próximo do clique.
      let best = Infinity;
      for (const d of pv.textDivs) {
        if (!d.isConnected || !d.textContent.trim()) continue;
        const r = d.getBoundingClientRect();
        const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
        const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
        const dist = dx * dx + dy * dy * 4;
        if (dist < best) {
          best = dist;
          span = d;
          offset = x > r.right ? d.textContent.length : 0;
        }
      }
    }
    if (!span) return null;
    const idx = pv.textDivs.indexOf(span);
    if (idx < 0) return null;
    const startRaw = pv.pageText.itemStart[idx];
    if (startRaw < 0) return null;
    return { page: pv.num, offset: startRaw + offset };
  }

  /** Converte a seleção atual em intervalo bruto (para marcar/traduzir trechos). */
  selectionText() {
    const sel = window.getSelection();
    return sel ? sel.toString().replace(/\s+/g, ' ').trim() : '';
  }

  destroy() {
    this.destroyed = true;
    this._observer?.disconnect();
    this._resizeObserver?.disconnect();
    this.container.removeEventListener('scroll', this._onScroll);
    for (const pv of this.pages) {
      try { pv.renderTask?.cancel(); } catch { /* ignora */ }
    }
    this.viewerEl.replaceChildren();
  }
}

export const VIEW_GAP = PAGE_GAP;
