// Tela de leitura: visualizador, narração com destaque, voz/idioma, tradução,
// legenda, sumário, marcadores, busca, timer de sono e exportação de audiolivro.

import { store } from './store.js';
import {
  $, $$, h, icon, setIcon, hydrateIcons, toast, openModal, contextMenu, showPopover, positionPopover,
  hidePopover, hideAllPopovers, isPopoverOpen, debounce, escapeHtml, formatDuration
} from './ui.js';
import { openPdf, BookText, spokenRangeToRaw } from './pdf-doc.js';
import { PdfViewer } from './pdf-viewer.js';
import { Narrator } from './narrator.js';
import { SystemEngine, EdgeEngine } from './tts.js';
import {
  baseLang, langName, translationCode, sameLanguage, BOOK_LANGUAGES, detectLanguage, sampleSentence
} from './lang.js';

// Vozes neurais mais naturais para leitura longa (usadas como padrão quando disponíveis).
const PREFERRED_VOICES = [
  'pt-BR-FranciscaNeural', 'pt-BR-AntonioNeural', 'pt-PT-RaquelNeural', 'en-US-AriaNeural', 'en-US-JennyNeural',
  'en-US-GuyNeural', 'en-GB-SoniaNeural', 'es-ES-ElviraNeural', 'es-MX-DaliaNeural', 'fr-FR-DeniseNeural',
  'de-DE-KatjaNeural', 'it-IT-ElsaNeural', 'ja-JP-NanamiNeural', 'zh-CN-XiaoxiaoNeural', 'ko-KR-SunHiNeural',
  'ru-RU-SvetlanaNeural', 'nl-NL-ColetteNeural'
];
const CHILD_VOICES = /AnaNeural|XiaoyouNeural|MaisieNeural|YunxiaNeural|LeticiaNeural|GiselleNeural/;
const SPEEDS = [0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const GENDER = { Female: 'feminina', Male: 'masculina' };
const PDF_THEMES = ['normal', 'sepia', 'night'];
const PDF_THEME_NAMES = { normal: 'normal', sepia: 'sépia', night: 'noturna' };

export const engines = { system: new SystemEngine(), edge: new EdgeEngine() };

function isTypingTarget(el) {
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

function foldWithMap(raw) {
  const out = [];
  const map = [];
  let lastSpace = false;
  for (let i = 0; i < raw.length; i++) {
    let ch = raw[i];
    if (/[\s\u2029]/.test(ch)) {
      if (lastSpace) continue;
      out.push(' ');
      map.push(i);
      lastSpace = true;
      continue;
    }
    lastSpace = false;
    ch = ch.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    for (const c of ch) {
      out.push(c);
      map.push(i);
    }
  }
  return { text: out.join(''), map };
}

const foldQuery = (q) => q.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();

export class ReaderView {
  constructor(root, { onClose }) {
    this.root = root;
    this.onClose = onClose;
    this.book = null;
    this.pdf = null;
    this.viewer = null;
    this.narrator = null;
    this.voiceLists = {};
    this.outline = [];
    this.chapterPages = [];
    this.sleepTimer = null;
    this.search = { token: 0, results: [], active: -1 };
    this.lastWordIdx = -1;
    this.audioLang = 'same';
    this._bind();
  }

  // ======================================================
  // Ligações de eventos fixos
  // ======================================================
  _bind() {
    const r = this.root;
    $('#btn-back', r).addEventListener('click', () => this.close());
    $('#btn-sidebar', r).addEventListener('click', () => this.toggleSidebar());
    $('#btn-page-prev', r).addEventListener('click', () => this.viewer?.goToPage(this.viewer.currentPage - 1));
    $('#btn-page-next', r).addEventListener('click', () => this.viewer?.goToPage(this.viewer.currentPage + 1));
    const pageInput = $('#page-input', r);
    pageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const n = parseInt(pageInput.value, 10);
        if (n) this.viewer?.goToPage(n);
        pageInput.blur();
      }
    });
    pageInput.addEventListener('focus', () => pageInput.select());
    pageInput.addEventListener('blur', () => { pageInput.value = this.viewer?.currentPage || ''; });
    $('#btn-zoom-in', r).addEventListener('click', () => this.viewer?.zoomBy(1.15));
    $('#btn-zoom-out', r).addEventListener('click', () => this.viewer?.zoomBy(1 / 1.15));
    $('#btn-zoom-mode', r).addEventListener('click', () => {
      if (!this.viewer) return;
      this.viewer.setZoom(this.viewer.zoomMode === 'width' ? 'page' : 'width');
    });
    $('#btn-search', r).addEventListener('click', () => this.openSearch());
    $('#btn-bookmark', r).addEventListener('click', () => this.toggleBookmark());
    $('#btn-add-bookmark', r).addEventListener('click', () => this.toggleBookmark(true));
    $('#btn-pdf-theme', r).addEventListener('click', () => {
      const next = PDF_THEMES[(PDF_THEMES.indexOf(store.settings.pdfTheme) + 1) % PDF_THEMES.length];
      store.updateSettings({ pdfTheme: next });
      this.applyPdfTheme();
      toast(`Cor da página: ${PDF_THEME_NAMES[next]}`, { duration: 1500 });
    });
    $('#btn-export', r).addEventListener('click', () => this.openExport());
    $('#btn-fullscreen', r).addEventListener('click', () => window.api.app.toggleFullscreen());
    $('#btn-help', r).addEventListener('click', () => this.showShortcuts());

    $$('.side-tabs button', r).forEach((b) => b.addEventListener('click', () => this.showSideTab(b.dataset.tab)));
    $('#search-input', r).addEventListener('input', debounce((e) => this.runSearch(e.target.value), 280));
    $('#search-input', r).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.stepSearch(e.shiftKey ? -1 : 1);
      }
    });

    // Player
    $('#btn-play', r).addEventListener('click', () => this.togglePlay());
    $('#btn-stop', r).addEventListener('click', () => this.stopNarration());
    $('#btn-next-sentence', r).addEventListener('click', () => this.stepSentence(1));
    $('#btn-prev-sentence', r).addEventListener('click', () => this.stepSentence(-1));
    const speed = $('#speed-select', r);
    speed.addEventListener('change', () => this.setRate(parseFloat(speed.value)));
    $('#btn-follow', r).addEventListener('click', () => {
      store.updateSettings({ follow: !store.settings.follow });
      this.syncToggles();
      toast(store.settings.follow ? 'A página vai acompanhar a narração.' : 'Rolagem automática desligada.', { duration: 1800 });
    });
    $('#btn-subtitle', r).addEventListener('click', () => {
      store.updateSettings({ subtitles: !store.settings.subtitles });
      this.syncToggles();
      this.updateSubtitleVisibility();
    });
    const timerBtn = $('#btn-timer', r);
    timerBtn.dataset.popoverAnchor = '';
    timerBtn.addEventListener('click', () => {
      const menu = $('#timer-menu', r);
      if (!menu.hidden) return hidePopover(menu);
      menu.dataset.anchoredTo = 'btn-timer';
      showPopover(menu, timerBtn, { placement: 'top-end' });
    });
    $$('#timer-menu button', r).forEach((b) => b.addEventListener('click', () => {
      hidePopover($('#timer-menu', r));
      this.setSleepTimer(b.dataset.timer);
    }));
    $('#chip-timer', r).addEventListener('click', () => this.setSleepTimer('0'));

    const voiceBtn = $('#btn-voice-settings', r);
    voiceBtn.dataset.popoverAnchor = '';
    voiceBtn.addEventListener('click', () => this.toggleVoicePanel());
    $('#chip-voice', r).addEventListener('click', () => this.toggleVoicePanel(true));
    $('[data-close-popover]', r).addEventListener('click', () => hidePopover($('#voice-panel', r)));
    this._bindVoicePanel();

    // Interações com o texto do PDF
    const container = $('#viewer-container', r);
    container.addEventListener('contextmenu', (e) => this.onTextContextMenu(e));
    let downPos = null;
    container.addEventListener('mousedown', (e) => { downPos = { x: e.clientX, y: e.clientY }; });
    container.addEventListener('mouseup', (e) => {
      if (e.button !== 0 || !downPos || !this.narrator) return;
      const moved = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > 4;
      const active = this.narrator.state !== 'idle';
      if (!moved && active && e.target.closest('.textLayer') && !this.viewer.selectionText()) {
        const pos = this.viewer.positionFromPoint(e.clientX, e.clientY);
        if (pos) this.listenFrom(pos);
      }
    });
    container.addEventListener('wheel', (e) => {
      if (e.ctrlKey && this.viewer) {
        e.preventDefault();
        this.viewer.zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1);
      }
    }, { passive: false });

    // Botões não devem roubar o foco (assim a barra de espaço continua controlando a narração).
    r.addEventListener('mousedown', (e) => {
      if (e.target.closest('.icon-btn, .play-btn, .chip, .zoom-label')) e.preventDefault();
    });

    document.addEventListener('keydown', (e) => this.onKey(e));
    window.api.media.onKey((action) => {
      if (!this.book) return;
      if (action === 'playpause') this.togglePlay();
      else if (action === 'next') this.stepSentence(1);
      else if (action === 'prev') this.stepSentence(-1);
      else if (action === 'stop') this.stopNarration();
    });

    store.addEventListener('settings', () => {
      if (!this.book) return;
      this.applyPdfTheme();
    });
    const speedSel = $('#speed-select', r);
    speedSel.replaceChildren(...SPEEDS.map((s) => h('option', { value: String(s), text: `${String(s).replace('.', ',')}x` })));

    setInterval(() => this._trackTime(), 15000);
  }

  // ======================================================
  // Abrir / fechar livro
  // ======================================================
  async open(bookId, { listen = false } = {}) {
    if (this.book) await this.close({ silent: true });
    const book = store.getBook(bookId);
    if (!book) return;
    this.book = book;
    this.audioLang = book.audioLang || store.settings.audioLang || 'same';
    const r = this.root;
    $('#reader-book-title', r).textContent = book.title;
    $('#reader-book-sub', r).textContent = book.author || '';
    $('#reader-loading', r).hidden = false;
    $('#sidebar', r).hidden = !store.settings.sidebarOpen;
    $('#btn-sidebar', r).classList.toggle('active', !!store.settings.sidebarOpen);
    this.showSideTab(store.settings.sidebarTab || 'outline');
    $('#search-input', r).value = '';
    $('#search-results', r).replaceChildren();
    $('#search-status', r).textContent = '';
    this.search = { token: 0, results: [], active: -1 };
    this.setPlayerStatus('Clique em <b>Ouvir</b> para começar a narração a partir do ponto visível da página.');
    this.clearSubtitle();
    this.syncToggles();
    this.applyPdfTheme();
    window.api.app.setTitle(book.title);

    try {
      const bytes = await window.api.library.readPdf(book.id);
      this.pdf = await openPdf(bytes);
    } catch (err) {
      $('#reader-loading', r).hidden = true;
      toast(`Não foi possível abrir o PDF: ${err.message}`, { type: 'error' });
      this.book = null;
      this.onClose();
      return;
    }
    if (this.book !== book) return;

    this.bookText = new BookText(this.pdf, book.language || 'en');
    this.viewer = new PdfViewer($('#viewer-container', r), $('#viewer', r), this.bookText);
    this.viewer.addEventListener('pagechange', (e) => this.onPageChange(e.detail.page));
    this.viewer.addEventListener('scalechange', () => this.updateZoomLabel());
    const startPage = listen && book.lastPosition?.page ? book.lastPosition.page : (book.lastPage || 1);
    await this.viewer.init(Math.min(startPage, this.pdf.numPages), book.zoom);
    $('#page-total', r).textContent = String(this.pdf.numPages);
    this.onPageChange(this.viewer.currentPage);
    this.updateZoomLabel();

    this.narrator = new Narrator({ bookText: this.bookText, engines, getConfig: () => this.narrationConfig() });
    this._bindNarrator();

    $('#reader-loading', r).hidden = true;
    $('#viewer-container', r).focus({ preventScroll: true });

    store.updateBook(book.id, { lastOpenedAt: Date.now(), pageCount: this.pdf.numPages }, { silent: true });
    this.renderBookmarks();
    this.loadOutline();
    await this.ensureBookLanguage();
    this.refreshVoiceUI().catch((err) => console.error(err));
    this.checkHasText();

    if (listen) {
      const pos = book.lastPosition && (await this.bookText.sentenceAt(book.lastPosition)) ? book.lastPosition : null;
      this.play(pos);
    }
  }

  async close({ silent = false } = {}) {
    if (!this.book) return;
    this.setSleepTimer('0', { quiet: true });
    this.narrator?.destroy();
    engines.edge.cancel();
    engines.system.cancel();
    window.api.media.enableKeys(false);
    hideAllPopovers();
    this._trackTime(true);
    this.saveProgress();
    this.viewer?.destroy();
    try { await this.pdf?.destroy(); } catch { /* ignora */ }
    this.viewer = null;
    this.narrator = null;
    this.pdf = null;
    this.bookText = null;
    this.book = null;
    this.clearSubtitle();
    window.api.app.setTitle('');
    if (!silent) this.onClose();
  }

  async ensureBookLanguage() {
    if (this.book.language) return;
    let sample = '';
    for (let p = 1; p <= Math.min(this.pdf.numPages, 8) && sample.length < 6000; p++) sample += ` ${await this.bookText.plainText(p)}`;
    const { lang } = detectLanguage(sample);
    if (lang) {
      await store.updateBook(this.book.id, { language: lang }, { silent: true });
      this.bookText.setLanguage(lang);
    }
  }

  async checkHasText() {
    let chars = 0;
    for (let p = 1; p <= Math.min(this.pdf.numPages, 6); p++) {
      const pt = await this.bookText.getPage(p);
      chars += pt?.raw.replace(/\s/g, '').length || 0;
    }
    if (chars < 20 && this.book) {
      toast('Este PDF parece ser digitalizado (só imagens). A leitura visual funciona, mas a narração precisa de texto selecionável.', { duration: 9000 });
    }
  }

  // ======================================================
  // Página, zoom e progresso
  // ======================================================
  onPageChange(page) {
    const r = this.root;
    if (document.activeElement !== $('#page-input', r)) $('#page-input', r).value = String(page);
    $('#btn-page-prev', r).disabled = page <= 1;
    $('#btn-page-next', r).disabled = page >= (this.pdf?.numPages || 1);
    this.updateBookmarkButton();
    this.highlightOutline(page);
    this._saveProgressSoon();
  }

  _saveProgressSoon = debounce(() => this.saveProgress(), 1200);

  saveProgress() {
    if (!this.book || !this.viewer) return;
    const page = this.viewer.currentPage;
    const total = this.pdf?.numPages || 1;
    const progress = total <= 1 ? 1 : Math.min(1, (page - 1) / (total - 1));
    const patch = { lastPage: page, zoom: { mode: this.viewer.zoomMode, scale: this.viewer.scale } };
    if (progress > (this.book.progress || 0) || page < (this.book.lastPage || 1)) patch.progress = Math.max(progress, 0);
    if (progress >= 0.999) patch.finished = true;
    if (this.narrator?.pos) patch.lastPosition = this.narrator.pos;
    store.patchBookQuiet(this.book.id, patch);
  }

  updateZoomLabel() {
    if (!this.viewer) return;
    const label = $('#btn-zoom-mode', this.root);
    label.textContent = `${Math.round(this.viewer.scale * 100)}%`;
    label.title = this.viewer.zoomMode === 'width' ? 'Ajustado à largura (clique para página inteira)' : this.viewer.zoomMode === 'page' ? 'Página inteira (clique para ajustar à largura)' : 'Zoom personalizado (clique para ajustar à largura)';
    this._saveProgressSoon();
  }

  applyPdfTheme() {
    const viewerEl = $('#viewer', this.root);
    viewerEl.classList.remove('pdf-sepia', 'pdf-night');
    if (store.settings.pdfTheme === 'sepia') viewerEl.classList.add('pdf-sepia');
    if (store.settings.pdfTheme === 'night') viewerEl.classList.add('pdf-night');
  }

  _trackTime(final = false) {
    if (!this.book) return;
    const now = Date.now();
    const last = this._lastTick || now;
    this._lastTick = final ? null : now;
    const secs = Math.min(30, Math.round((now - last) / 1000));
    if (secs <= 0) return;
    const listening = this.narrator?.state === 'playing';
    if (!listening && !document.hasFocus()) return;
    const patch = listening
      ? { listeningSeconds: (this.book.listeningSeconds || 0) + secs }
      : { readingSeconds: (this.book.readingSeconds || 0) + secs };
    store.patchBookQuiet(this.book.id, patch);
  }

  // ======================================================
  // Barra lateral: sumário, marcadores e busca
  // ======================================================
  toggleSidebar(force) {
    const sb = $('#sidebar', this.root);
    const open = force ?? sb.hidden;
    sb.hidden = !open;
    $('#btn-sidebar', this.root).classList.toggle('active', open);
    store.updateSettings({ sidebarOpen: open });
  }

  showSideTab(tab) {
    $$('.side-tabs button', this.root).forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    $$('.side-panel', this.root).forEach((p) => { p.hidden = p.dataset.panel !== tab; });
    if (store.settings.sidebarTab !== tab) store.updateSettings({ sidebarTab: tab });
  }

  openSearch() {
    this.toggleSidebar(true);
    this.showSideTab('search');
    const input = $('#search-input', this.root);
    const sel = this.viewer?.selectionText();
    if (sel && sel.length < 80) {
      input.value = sel;
      this.runSearch(sel);
    }
    input.focus();
    input.select();
  }

  async loadOutline() {
    const box = $('#outline-list', this.root);
    box.replaceChildren(h('div.side-empty', { text: 'Carregando sumário…' }));
    const pdf = this.pdf;
    let outline = null;
    try { outline = await pdf.getOutline(); } catch { outline = null; }
    if (pdf !== this.pdf) return;
    if (!outline || !outline.length) {
      this.outline = [];
      this.chapterPages = [];
      box.replaceChildren(h('div.side-empty', { text: 'Este PDF não possui sumário. Use os marcadores para guardar páginas importantes.' }));
      return;
    }
    const resolve = async (dest) => {
      try {
        const explicit = typeof dest === 'string' ? await pdf.getDestination(dest) : dest;
        if (!Array.isArray(explicit)) return null;
        const ref = explicit[0];
        if (typeof ref === 'number') return ref + 1;
        return (await pdf.getPageIndex(ref)) + 1;
      } catch {
        return null;
      }
    };
    const pages = [];
    const build = async (items, depth) => {
      const frag = document.createDocumentFragment();
      for (const item of items) {
        const page = item.dest ? await resolve(item.dest) : null;
        if (page) pages.push(page);
        const btn = h('button.outline-item', { dataset: { page: page || '' }, title: item.title },
          page ? h('span.op', { text: String(page) }) : null,
          item.title);
        btn.addEventListener('click', () => { if (page) this.viewer.goToPage(page); });
        frag.append(btn);
        if (item.items?.length && depth < 4) {
          const children = h('div.outline-children');
          children.append(await build(item.items, depth + 1));
          frag.append(children);
        }
      }
      return frag;
    };
    const frag = await build(outline, 0);
    if (pdf !== this.pdf) return;
    box.replaceChildren(frag);
    this.chapterPages = [...new Set(pages)].sort((a, b) => a - b);
    this.highlightOutline(this.viewer.currentPage);
  }

  highlightOutline(page) {
    const items = $$('#outline-list .outline-item', this.root);
    let best = null;
    for (const it of items) {
      const p = Number(it.dataset.page);
      if (p && p <= page && (!best || p >= Number(best.dataset.page))) best = it;
    }
    items.forEach((it) => it.classList.toggle('current', it === best));
  }

  bookmarks() {
    return (this.book?.bookmarks || []).slice().sort((a, b) => a.page - b.page);
  }

  updateBookmarkButton() {
    if (!this.book || !this.viewer) return;
    const marked = this.bookmarks().some((b) => b.page === this.viewer.currentPage);
    const btn = $('#btn-bookmark', this.root);
    setIcon(btn.querySelector('[data-icon]'), marked ? 'bookmark-filled' : 'bookmark');
    btn.classList.toggle('active', marked);
    btn.title = marked ? 'Remover marcador desta página (Ctrl B)' : 'Marcar esta página (Ctrl B)';
  }

  async toggleBookmark(onlyAdd = false) {
    if (!this.book || !this.viewer) return;
    const page = this.viewer.currentPage;
    let list = (this.book.bookmarks || []).slice();
    const existing = list.find((b) => b.page === page);
    if (existing && !onlyAdd) {
      list = list.filter((b) => b !== existing);
      toast(`Marcador da página ${page} removido.`, { duration: 1800 });
    } else if (!existing) {
      let excerpt = '';
      const cur = this.narrator?.current?.sentence;
      if (cur && cur.page === page) excerpt = cur.text;
      else excerpt = (await this.bookText.plainText(page)).replace(/\s+/g, ' ').trim();
      list.push({ id: crypto.randomUUID(), page, note: '', excerpt: excerpt.slice(0, 220), createdAt: Date.now() });
      toast(`Página ${page} marcada.`, { duration: 1800 });
    }
    await store.updateBook(this.book.id, { bookmarks: list }, { silent: true });
    this.renderBookmarks();
    this.updateBookmarkButton();
  }

  renderBookmarks() {
    const box = $('#bookmark-list', this.root);
    const list = this.bookmarks();
    if (!list.length) {
      box.replaceChildren(h('div.side-empty', { text: 'Nenhum marcador ainda. Use Ctrl+B ou o botão acima para marcar a página atual e anotar ideias.' }));
      return;
    }
    box.replaceChildren(...list.map((bm) => {
      const note = h('textarea', { placeholder: 'Escreva uma anotação…', rows: '2' });
      note.value = bm.note || '';
      note.addEventListener('click', (e) => e.stopPropagation());
      note.addEventListener('input', debounce(() => {
        const all = (this.book.bookmarks || []).map((b) => (b.id === bm.id ? { ...b, note: note.value } : b));
        store.updateBook(this.book.id, { bookmarks: all }, { silent: true });
      }, 500));
      const del = h('button.icon-btn', { title: 'Remover marcador', html: icon('trash') });
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        const all = (this.book.bookmarks || []).filter((b) => b.id !== bm.id);
        store.updateBook(this.book.id, { bookmarks: all }, { silent: true }).then(() => {
          this.renderBookmarks();
          this.updateBookmarkButton();
        });
      });
      const item = h('div.bookmark-item', {},
        h('div.bm-head', {}, h('span', { html: icon('bookmark-filled') }), h('span.bm-page', { text: `Página ${bm.page}` }), del),
        bm.excerpt ? h('div.bm-excerpt', { text: bm.excerpt }) : null,
        note);
      item.addEventListener('click', () => this.viewer.goToPage(bm.page));
      return item;
    }));
  }

  async runSearch(query) {
    const token = ++this.search.token;
    const status = $('#search-status', this.root);
    const box = $('#search-results', this.root);
    box.replaceChildren();
    this.search.results = [];
    this.search.active = -1;
    this.viewer?.clearHighlights('search', 'searchActive');
    const q = foldQuery(query || '');
    if (q.length < 2) {
      status.textContent = q ? 'Digite pelo menos 2 letras.' : '';
      return;
    }
    status.textContent = 'Buscando…';
    const total = this.pdf.numPages;
    const results = [];
    for (let p = 1; p <= total; p++) {
      if (token !== this.search.token || !this.bookText) return;
      const pt = await this.bookText.getPage(p);
      if (!pt || !pt.raw) continue;
      const { text, map } = foldWithMap(pt.raw);
      let idx = text.indexOf(q);
      while (idx >= 0 && results.length < 1000) {
        const start = map[idx];
        const end = map[Math.min(idx + q.length - 1, map.length - 1)] + 1;
        const ctxStart = Math.max(0, start - 50);
        const ctxEnd = Math.min(pt.raw.length, end + 70);
        results.push({
          page: p, start, end,
          before: pt.raw.slice(ctxStart, start).replace(/[\s\u2029]+/g, ' '),
          match: pt.raw.slice(start, end).replace(/[\s\u2029]+/g, ' '),
          after: pt.raw.slice(end, ctxEnd).replace(/[\s\u2029]+/g, ' ')
        });
        idx = text.indexOf(q, idx + q.length);
      }
      if (p % 15 === 0 || p === total) {
        status.textContent = `${results.length} resultado(s)${p < total ? ` · buscando… ${Math.round((p / total) * 100)}%` : ''}`;
        this._renderSearchResults(results);
        await new Promise((res) => setTimeout(res, 0));
      }
    }
    if (token !== this.search.token) return;
    this.search.results = results;
    this.viewer.setHighlight('search', results.map(({ page, start, end }) => ({ page, start, end })));
    status.textContent = results.length ? `${results.length} resultado(s) — Enter para o próximo` : 'Nada encontrado.';
    this._renderSearchResults(results);
  }

  _renderSearchResults(results) {
    const box = $('#search-results', this.root);
    const already = box.children.length;
    for (let i = already; i < Math.min(results.length, 300); i++) {
      const res = results[i];
      const btn = h('button.search-result', { html: `<span class="sr-page">Página ${res.page}</span>…${escapeHtml(res.before)}<b>${escapeHtml(res.match)}</b>${escapeHtml(res.after)}…` });
      btn.addEventListener('click', () => this.gotoSearchResult(i));
      box.append(btn);
    }
    this.search.results = results;
  }

  gotoSearchResult(i) {
    const res = this.search.results[i];
    if (!res) return;
    this.search.active = i;
    $$('.search-result', this.root).forEach((b, idx) => b.classList.toggle('active', idx === i));
    const range = { page: res.page, start: res.start, end: res.end };
    this.viewer.setHighlight('searchActive', [range]);
    this.viewer.revealRanges([range], { force: true });
  }

  stepSearch(dir) {
    const n = this.search.results.length;
    if (!n) return;
    this.gotoSearchResult(((this.search.active + dir) % n + n) % n);
  }

  // ======================================================
  // Voz, idioma e tradução
  // ======================================================
  async getVoices(engineId) {
    if (this.voiceLists[engineId]) return this.voiceLists[engineId];
    const list = (await engines[engineId].voices()) || [];
    if (list.length) this.voiceLists[engineId] = list;
    return list;
  }

  bookLang() {
    return this.book?.language || null;
  }

  audioLangCode() {
    if (this.audioLang && this.audioLang !== 'same') return this.audioLang;
    return this.bookLang() || baseLang(navigator.language) || 'pt';
  }

  voicesFor(list, lang) {
    const base = baseLang(lang);
    const uiRegion = (navigator.language || 'pt-BR').split('-')[1];
    return list
      .filter((v) => baseLang(v.locale) === base)
      .sort((a, b) => {
        const ra = a.locale.endsWith(`-${uiRegion}`) || (base === 'en' && a.locale === 'en-US') ? 0 : 1;
        const rb = b.locale.endsWith(`-${uiRegion}`) || (base === 'en' && b.locale === 'en-US') ? 0 : 1;
        if (ra !== rb) return ra - rb;
        if (a.locale !== b.locale) return a.locale.localeCompare(b.locale);
        const pa = PREFERRED_VOICES.indexOf(a.id);
        const pb = PREFERRED_VOICES.indexOf(b.id);
        if (pa !== pb) return (pa < 0 ? 999 : pa) - (pb < 0 ? 999 : pb);
        if (CHILD_VOICES.test(a.id) !== CHILD_VOICES.test(b.id)) return CHILD_VOICES.test(a.id) ? 1 : -1;
        if (a.multilingual !== b.multilingual) return a.multilingual ? 1 : -1;
        return a.name.localeCompare(b.name);
      });
  }

  currentVoice() {
    const engineId = store.settings.engine;
    const list = this.voiceLists[engineId] || [];
    const lang = this.audioLangCode();
    const candidates = this.voicesFor(list, lang);
    const saved = store.settings.voiceByLang?.[`${engineId}:${baseLang(lang)}`];
    return candidates.find((v) => v.id === saved) || candidates[0] || null;
  }

  narrationConfig() {
    const s = store.settings;
    const voice = this.currentVoice();
    const bookLang = this.bookLang();
    let translateTo = null;
    if (voice && this.audioLang !== 'same') {
      if (!bookLang || !sameLanguage(bookLang, voice.locale)) translateTo = translationCode(voice.locale);
    }
    return {
      engine: s.engine,
      voice: voice?.id || null,
      voiceLocale: voice?.locale || this.audioLangCode(),
      rate: s.rate,
      pitch: s.pitch,
      volume: s.volume,
      bookLang: bookLang ? translationCode(bookLang) : null,
      translateTo
    };
  }

  _bindVoicePanel() {
    const r = this.root;
    $$('#engine-select button', r).forEach((b) => b.addEventListener('click', async () => {
      await store.updateSettings({ engine: b.dataset.engine });
      await this.refreshVoiceUI();
      this.narrator?.restart();
    }));
    $('#book-lang-select', r).addEventListener('change', async (e) => {
      const lang = e.target.value || null;
      await store.updateBook(this.book.id, { language: lang }, { silent: true });
      this.bookText.setLanguage(lang || 'en');
      await this.refreshVoiceUI();
      this.narrator?.restart();
    });
    $('#audio-lang-select', r).addEventListener('change', async (e) => {
      this.audioLang = e.target.value;
      await store.updateBook(this.book.id, { audioLang: this.audioLang }, { silent: true });
      store.updateSettings({ audioLang: this.audioLang });
      await this.refreshVoiceUI();
      this.narrator?.restart();
    });
    $('#voice-select', r).addEventListener('change', async (e) => {
      const key = `${store.settings.engine}:${baseLang(this.audioLangCode())}`;
      await store.updateSettings({ voiceByLang: { ...store.settings.voiceByLang, [key]: e.target.value } });
      await this.refreshVoiceUI();
      this.narrator?.restart();
    });
    $('#rate-range', r).addEventListener('input', (e) => this.setRate(parseFloat(e.target.value), { fromSlider: true }));
    $('#pitch-range', r).addEventListener('input', (e) => {
      $('#pitch-out', r).textContent = `${e.target.value > 0 ? '+' : ''}${e.target.value}%`;
    });
    $('#pitch-range', r).addEventListener('change', async (e) => {
      await store.updateSettings({ pitch: parseInt(e.target.value, 10) });
      this.narrator?.restart();
    });
    $('#volume-range', r).addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      $('#volume-out', r).textContent = `${Math.round(v * 100)}%`;
      store.updateSettings({ volume: v });
      this.narrator?.setVolume(v);
    });
    $('#word-highlight-check', r).addEventListener('change', (e) => {
      store.updateSettings({ wordHighlight: e.target.checked });
      if (!e.target.checked) this.viewer?.clearHighlights('word');
    });
    $('#btn-test-voice', r).addEventListener('click', () => this.testVoice());
  }

  toggleVoicePanel(forceOpen = false) {
    const panel = $('#voice-panel', this.root);
    if (!panel.hidden && !forceOpen) {
      hidePopover(panel);
      return;
    }
    panel.dataset.anchoredTo = 'btn-voice-settings';
    showPopover(panel, null);
    panel.style.left = 'auto';
    panel.style.top = 'auto';
    panel.style.right = '18px';
    panel.style.bottom = '86px';
    this.refreshVoiceUI().catch((err) => console.error(err));
  }

  async refreshVoiceUI() {
    const r = this.root;
    const s = store.settings;
    $$('#engine-select button', r).forEach((b) => b.classList.toggle('active', b.dataset.engine === s.engine));
    $('#voice-error', r).textContent = '';

    // Idioma do livro
    const bookLang = this.bookLang();
    const bookSel = $('#book-lang-select', r);
    const langs = new Set(BOOK_LANGUAGES);
    if (bookLang) langs.add(bookLang);
    bookSel.replaceChildren(
      h('option', { value: '', text: 'Não identificado' }),
      ...[...langs].map((code) => h('option', { value: code, text: langName(code) })).sort((a, b) => a.text.localeCompare(b.text, 'pt-BR'))
    );
    bookSel.value = bookLang || '';

    // Vozes do motor atual
    let list = [];
    const voiceSel = $('#voice-select', r);
    try {
      list = await this.getVoices(s.engine);
    } catch (err) {
      $('#voice-error', r).textContent = err.message;
      if (s.engine === 'edge') {
        toast('Sem acesso às vozes neurais online. Usando as vozes do Windows.', { type: 'error' });
        await store.updateSettings({ engine: 'system' });
        return this.refreshVoiceUI();
      }
    }

    const audioSel = $('#audio-lang-select', r);
    const available = [...new Set(list.map((v) => baseLang(v.locale)))]
      .map((code) => ({ code, name: langName(code) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    audioSel.replaceChildren(
      h('option', { value: 'same', text: `Mesmo idioma do texto${bookLang ? ` (${langName(bookLang)})` : ''}` }),
      h('option', { disabled: true, text: '── Traduzir e ouvir em ──' }),
      ...available.map((l) => h('option', { value: l.code, text: l.name }))
    );
    if (this.audioLang !== 'same' && !available.some((l) => l.code === this.audioLang)) {
      audioSel.append(h('option', { value: this.audioLang, text: `${langName(this.audioLang)} (sem voz neste tipo)` }));
    }
    audioSel.value = this.audioLang || 'same';

    const lang = this.audioLangCode();
    const voices = this.voicesFor(list, lang);
    const current = this.currentVoice();
    const groups = new Map();
    for (const v of voices) {
      if (!groups.has(v.locale)) groups.set(v.locale, []);
      groups.get(v.locale).push(v);
    }
    voiceSel.replaceChildren(...[...groups.entries()].map(([locale, vs]) => {
      const og = h('optgroup', { label: langName(locale) });
      og.append(...vs.map((v) => h('option', { value: v.id, text: `${v.name} — voz ${GENDER[v.gender] || v.gender || ''}${v.multilingual ? ' · multilíngue' : ''}` })));
      return og;
    }));
    if (current) voiceSel.value = current.id;
    voiceSel.disabled = !voices.length;
    $('#voice-count', r).textContent = voices.length ? `(${voices.length} disponíveis)` : '';

    // Aviso sobre tradução / falta de voz
    const note = $('#translation-note', r);
    const cfg = this.narrationConfig();
    note.classList.remove('note-warn');
    if (!voices.length) {
      note.hidden = false;
      note.classList.add('note-warn');
      note.textContent = s.engine === 'system'
        ? `Não há voz do Windows instalada para ${langName(lang)}. Use as vozes neurais online, instale uma voz em Configurações do Windows › Hora e idioma › Fala, ou escolha ouvir em outro idioma.`
        : `Nenhuma voz neural disponível para ${langName(lang)}.`;
    } else if (cfg.translateTo) {
      note.hidden = false;
      note.innerHTML = `${icon('languages')} <b>Tradução simultânea ativada:</b> o texto ${bookLang ? `em ${escapeHtml(langName(bookLang))}` : 'do PDF'} será traduzido e lido em ${escapeHtml(langName(current.locale))}. A frase original continua destacada no PDF.`;
    } else {
      note.hidden = true;
    }

    // Controles deslizantes
    $('#rate-range', r).value = String(s.rate);
    $('#rate-out', r).textContent = `${String(Number(s.rate).toFixed(2)).replace(/\.?0+$/, '').replace('.', ',')}x`;
    $('#pitch-range', r).value = String(s.pitch);
    $('#pitch-out', r).textContent = `${s.pitch > 0 ? '+' : ''}${s.pitch}%`;
    $('#volume-range', r).value = String(s.volume);
    $('#volume-out', r).textContent = `${Math.round(s.volume * 100)}%`;
    $('#word-highlight-check', r).checked = !!s.wordHighlight;
    this.syncSpeedSelect();
    this.updateChips();
  }

  updateChips() {
    const r = this.root;
    const voice = this.currentVoice();
    const chip = $('#chip-voice', r);
    chip.innerHTML = `${icon('volume')}<span></span>`;
    chip.querySelector('span').textContent = voice ? `${voice.name} · ${langName(voice.locale)}` : 'Escolher voz';
    const cfg = this.narrationConfig();
    const tchip = $('#chip-translation', r);
    if (cfg.translateTo) {
      tchip.hidden = false;
      tchip.innerHTML = `${icon('languages')}<span></span>`;
      tchip.querySelector('span').textContent = `Tradução ${(cfg.bookLang || 'auto').toUpperCase()} → ${cfg.translateTo.toUpperCase()}`;
      tchip.title = `Tradução simultânea de ${langName(cfg.bookLang || '') || 'idioma automático'} para ${langName(cfg.translateTo)}`;
    } else {
      tchip.hidden = true;
    }
  }

  syncSpeedSelect() {
    const sel = $('#speed-select', this.root);
    const rate = Number(store.settings.rate);
    let opt = [...sel.options].find((o) => Math.abs(parseFloat(o.value) - rate) < 0.001);
    [...sel.querySelectorAll('option[data-custom]')].forEach((o) => { if (o !== opt) o.remove(); });
    if (!opt) {
      opt = h('option', { value: String(rate), text: `${String(rate.toFixed(2)).replace(/\.?0+$/, '').replace('.', ',')}x`, dataset: { custom: '1' } });
      sel.append(opt);
    }
    sel.value = opt.value;
  }

  setRate(rate, { fromSlider = false } = {}) {
    rate = Math.max(0.5, Math.min(3, rate));
    store.updateSettings({ rate });
    this.narrator?.setRate(rate);
    $('#rate-out', this.root).textContent = `${String(rate.toFixed(2)).replace(/\.?0+$/, '').replace('.', ',')}x`;
    if (!fromSlider) $('#rate-range', this.root).value = String(rate);
    this.syncSpeedSelect();
  }

  async testVoice() {
    const cfg = this.narrationConfig();
    if (!cfg.voice) {
      $('#voice-error', this.root).textContent = 'Nenhuma voz disponível para este idioma.';
      return;
    }
    if (this.narrator && this.narrator.state !== 'idle') this.narrator.stop();
    let text = sampleSentence(cfg.voiceLocale);
    if (!text) {
      text = 'Olá! Esta é a voz que vai ler o seu livro.';
      try {
        text = (await window.api.translate.text({ text, from: 'pt', to: translationCode(cfg.voiceLocale) })).text;
      } catch { /* mantém em português */ }
    }
    const engine = engines[cfg.engine];
    const btn = $('#btn-test-voice', this.root);
    btn.disabled = true;
    engine.speak(text, { voice: cfg.voice, lang: cfg.voiceLocale, rate: cfg.rate, pitch: cfg.pitch, volume: cfg.volume }, {
      onEnd: () => { btn.disabled = false; },
      onError: (err) => {
        btn.disabled = false;
        $('#voice-error', this.root).textContent = err.message;
      }
    });
    setTimeout(() => { btn.disabled = false; }, 8000);
  }

  // ======================================================
  // Narração
  // ======================================================
  _bindNarrator() {
    const n = this.narrator;
    n.addEventListener('state', (e) => this.onNarratorState(e.detail.state));
    n.addEventListener('sentence', (e) => this.onSentence(e.detail));
    n.addEventListener('spoken', (e) => this.onSpoken(e.detail));
    n.addEventListener('word', (e) => this.onWord(e.detail));
    n.addEventListener('finished', () => {
      this.viewer?.clearHighlights('sentence', 'word');
      this.setPlayerStatus('<b>Fim do livro.</b> Que leitura! 🎉');
      store.patchBookQuiet(this.book.id, { finished: true, progress: 1 });
      toast('Narração concluída: você chegou ao fim do livro.');
    });
    n.addEventListener('stopped', () => {
      this.viewer?.clearHighlights('sentence', 'word');
      this.clearSubtitle();
      this.setPlayerStatus('Narração parada. Clique em <b>Ouvir</b> para recomeçar do ponto visível.');
    });
    n.addEventListener('timerstop', () => {
      this.setSleepTimer('0', { quiet: true });
      toast('Timer de sono: narração pausada. Bom descanso! 🌙', { duration: 6000 });
    });
    n.addEventListener('error', (e) => this.onNarratorError(e.detail));
  }

  onNarratorState(state) {
    const btn = $('#btn-play', this.root);
    const playing = state === 'playing' || state === 'loading';
    setIcon(btn.querySelector('.play-icon'), playing ? 'pause' : 'play');
    btn.querySelector('.play-label').textContent = state === 'loading' ? 'Preparando…' : playing ? 'Pausar' : state === 'paused' ? 'Continuar' : 'Ouvir';
    btn.classList.toggle('loading', state === 'loading');
    $('#viewer', this.root).classList.toggle('listening', state !== 'idle');
    window.api.media.enableKeys(state !== 'idle');
    if (state === 'paused') {
      const cur = this.narrator.current?.sentence;
      this.setPlayerStatus(`Pausado na página <b>${cur?.page || this.viewer.currentPage}</b>. Espaço para continuar · clique numa frase para ouvir dali.`);
    }
    this.updateSubtitleVisibility();
    this._trackTime();
  }

  onSentence({ sentence, translating, preview }) {
    if (!sentence || !this.viewer) return;
    this.lastWordIdx = -1;
    this.viewer.setHighlight('sentence', sentence.segments);
    this.viewer.clearHighlights('word');
    if (store.settings.follow) {
      const inset = !$('#subtitle', this.root).hidden ? $('#subtitle', this.root).offsetHeight + 30 : 0;
      this.viewer.revealRanges(sentence.segments, { bottomInset: inset });
    }
    if (!preview) {
      const total = this.pdf.numPages;
      this.setPlayerStatus(`${translating ? 'Traduzindo e lendo' : 'Lendo'} a página <b>${sentence.page}</b> de ${total}`);
    }
    // Legenda
    const orig = $('#sub-orig', this.root);
    const main = $('#sub-main', this.root);
    if (translating) {
      orig.textContent = sentence.text;
      main.replaceChildren(h('span.sub-loading', { text: 'Traduzindo…' }));
    } else {
      orig.textContent = '';
      this._fillSubtitle(sentence.text);
    }
    this._savePositionSoon();
  }

  _savePositionSoon = debounce(() => {
    if (this.book && this.narrator?.pos) store.patchBookQuiet(this.book.id, { lastPosition: this.narrator.pos });
  }, 2000);

  onSpoken({ spoken, translating }) {
    if (translating) this._fillSubtitle(spoken);
  }

  _fillSubtitle(text) {
    const main = $('#sub-main', this.root);
    const frag = document.createDocumentFragment();
    const re = /\S+/g;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > last) frag.append(text.slice(last, m.index));
      const span = document.createElement('span');
      span.className = 'w todo';
      span.dataset.s = String(m.index);
      span.dataset.e = String(m.index + m[0].length);
      span.textContent = m[0];
      frag.append(span);
      last = m.index + m[0].length;
    }
    if (last < text.length) frag.append(text.slice(last));
    main.replaceChildren(frag);
    main.scrollTop = 0;
  }

  onWord({ sentence, start, end, translating }) {
    // Legenda: marca a palavra atual
    const spans = $('#sub-main', this.root).querySelectorAll('.w');
    let currentSpan = null;
    for (const sp of spans) {
      const s = Number(sp.dataset.s);
      const e = Number(sp.dataset.e);
      const isOn = start < e && end > s;
      sp.classList.toggle('on', isOn);
      sp.classList.toggle('done', e <= start);
      sp.classList.toggle('todo', s >= end);
      if (isOn && !currentSpan) currentSpan = sp;
    }
    if (currentSpan) {
      const main = $('#sub-main', this.root);
      if (currentSpan.offsetTop - main.scrollTop > main.clientHeight - 24) main.scrollTop = currentSpan.offsetTop - 8;
    }
    // PDF: palavra atual (só quando o texto falado é o próprio texto do PDF)
    if (!translating && store.settings.wordHighlight && this.viewer) {
      this.viewer.setHighlight('word', spokenRangeToRaw(sentence, start, end));
    }
  }

  onNarratorError({ error, kind, engine }) {
    console.error('Erro na narração:', error);
    if (kind === 'translate') {
      toast(error.message || 'Falha na tradução.', {
        type: 'error',
        duration: 8000,
        action: { label: 'Ouvir no idioma original', onClick: () => this.setAudioLang('same', true) }
      });
      this.setPlayerStatus('A tradução falhou. Verifique sua conexão com a internet.');
    } else if (engine === 'edge') {
      toast(`Voz neural indisponível (${error.message}).`, {
        type: 'error',
        duration: 9000,
        action: { label: 'Usar vozes do Windows', onClick: () => this.switchEngine('system', true) }
      });
      this.setPlayerStatus('Não foi possível gerar a voz neural online.');
    } else {
      toast(error.message || 'Falha na voz.', { type: 'error' });
    }
  }

  async setAudioLang(lang, resume = false) {
    this.audioLang = lang;
    await store.updateBook(this.book.id, { audioLang: lang }, { silent: true });
    await this.refreshVoiceUI();
    if (resume) this.narrator.play(this.narrator.pos);
  }

  async switchEngine(engineId, resume = false) {
    await store.updateSettings({ engine: engineId });
    await this.refreshVoiceUI();
    if (resume) this.narrator.play(this.narrator.pos);
  }

  setPlayerStatus(html) {
    $('#player-status', this.root).innerHTML = html;
  }

  updateSubtitleVisibility() {
    const show = store.settings.subtitles && this.narrator && this.narrator.state !== 'idle';
    $('#subtitle', this.root).hidden = !show;
  }

  clearSubtitle() {
    $('#sub-orig', this.root).textContent = '';
    $('#sub-main', this.root).replaceChildren();
    $('#subtitle', this.root).hidden = true;
  }

  syncToggles() {
    $('#btn-follow', this.root).classList.toggle('on', !!store.settings.follow);
    $('#btn-subtitle', this.root).classList.toggle('on', !!store.settings.subtitles);
  }

  /** Posição inicial: a primeira frase visível na tela. */
  async startPosition() {
    const n = this.narrator;
    const current = this.viewer.currentPage;
    if (n.pos && Math.abs(n.pos.page - current) <= 1) return n.pos;
    const container = $('#viewer-container', this.root);
    const rect = container.getBoundingClientRect();
    for (const dy of [60, 120, 200, 320]) {
      const pos = this.viewer.positionFromPoint(rect.left + rect.width / 2, rect.top + dy);
      if (pos) {
        const loc = await this.bookText.locate(pos.page, pos.offset);
        if (loc) return loc;
      }
    }
    return this.bookText.firstFrom(current);
  }

  async play(pos = null) {
    if (!this.narrator) return;
    if (!this.voiceLists[store.settings.engine]) await this.refreshVoiceUI().catch(() => {});
    let cfg = this.narrationConfig();
    if (!cfg.voice) {
      // Sem voz neste tipo para o idioma: tenta o outro tipo de voz antes de desistir.
      const other = store.settings.engine === 'system' ? 'edge' : 'system';
      const otherList = await this.getVoices(other).catch(() => []);
      if (this.voicesFor(otherList, this.audioLangCode()).length) {
        await this.switchEngine(other);
        cfg = this.narrationConfig();
        toast(other === 'edge'
          ? `Não há voz do Windows para ${langName(this.audioLangCode())}; usando as vozes neurais online.`
          : `Usando a voz do Windows para ${langName(this.audioLangCode())}.`, { duration: 5000 });
      }
    }
    if (!cfg.voice) {
      toast('Nenhuma voz disponível para o idioma escolhido. Abra "Voz e idioma" para escolher outra.', { type: 'error' });
      this.toggleVoicePanel(true);
      return;
    }
    const start = pos || (await this.startPosition());
    if (!start) {
      toast('Não há texto para ler a partir daqui. Se o PDF for digitalizado (imagens), a narração não é possível.', { type: 'error', duration: 7000 });
      return;
    }
    this.narrator.play(start);
  }

  togglePlay() {
    if (!this.narrator) return;
    const st = this.narrator.state;
    if (st === 'idle') this.play();
    else this.narrator.toggle();
  }

  stopNarration() {
    this.narrator?.stop();
  }

  async stepSentence(dir) {
    if (!this.narrator) return;
    if (!this.narrator.pos) {
      await this.play();
      return;
    }
    if (dir > 0) this.narrator.next(); else this.narrator.prev();
  }

  async listenFrom(pos) {
    const loc = await this.bookText.locate(pos.page, pos.offset);
    if (loc) this.play(loc);
  }

  // ======================================================
  // Timer de sono
  // ======================================================
  setSleepTimer(value, { quiet = false } = {}) {
    clearInterval(this.sleepTimer?.interval);
    this.sleepTimer = null;
    const chip = $('#chip-timer', this.root);
    const n = this.narrator;
    if (n) {
      n.stopAtPageEnd = null;
      n.stopBeforePage = null;
      n.stopAfterCurrent = false;
    }
    $$('#timer-menu button', this.root).forEach((b) => b.classList.toggle('active', b.dataset.timer === value));
    $('#btn-timer', this.root).classList.toggle('on', value !== '0');
    if (value === '0' || !n) {
      chip.hidden = true;
      if (!quiet && value === '0') toast('Timer de sono desligado.', { duration: 1500 });
      return;
    }
    chip.hidden = false;
    if (value === 'page') {
      const page = n.pos?.page || this.viewer.currentPage;
      n.stopAtPageEnd = page;
      chip.innerHTML = `${icon('moon')}<span>Parar no fim da pág. ${page}</span>`;
    } else if (value === 'chapter') {
      const from = n.pos?.page || this.viewer.currentPage;
      const next = this.chapterPages.find((p) => p > from);
      if (!next) {
        chip.hidden = true;
        toast(this.chapterPages.length ? 'Você já está no último capítulo.' : 'Este PDF não tem sumário para identificar capítulos. Use “Fim da página” ou minutos.', { type: 'error' });
        return;
      }
      n.stopBeforePage = next;
      chip.innerHTML = `${icon('moon')}<span>Parar no fim do capítulo (pág. ${next - 1})</span>`;
    } else {
      const minutes = parseInt(value, 10);
      const endAt = Date.now() + minutes * 60000;
      const update = () => {
        const left = Math.max(0, endAt - Date.now());
        chip.innerHTML = `${icon('moon')}<span>${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}</span>`;
        if (left <= 0) {
          clearInterval(this.sleepTimer?.interval);
          if (this.narrator) this.narrator.stopAfterCurrent = true;
          chip.innerHTML = `${icon('moon')}<span>terminando a frase…</span>`;
        }
      };
      this.sleepTimer = { interval: setInterval(update, 1000) };
      update();
    }
    chip.title = 'Clique para cancelar o timer';
    if (!quiet) toast('Timer de sono ativado.', { duration: 1500 });
  }

  // ======================================================
  // Menu de contexto do texto
  // ======================================================
  onTextContextMenu(e) {
    if (!this.viewer) return;
    e.preventDefault();
    const pos = this.viewer.positionFromPoint(e.clientX, e.clientY);
    const sel = this.viewer.selectionText();
    const items = [];
    if (pos) items.push({ label: 'Ouvir a partir daqui', icon: 'play', onClick: () => this.listenFrom(pos) });
    if (sel) {
      items.push({ label: 'Ouvir o trecho selecionado', icon: 'volume', onClick: () => this.speakSelection(sel) });
      items.push({ label: 'Traduzir o trecho selecionado', icon: 'languages', onClick: () => this.translateSelection(sel, e.clientX, e.clientY) });
      items.push({ label: 'Copiar', icon: 'copy', onClick: () => navigator.clipboard.writeText(sel) });
      items.push({ label: 'Buscar no livro', icon: 'search', onClick: () => this.openSearch() });
    }
    items.push('-');
    const page = pos?.page || this.viewer.currentPage;
    const marked = this.bookmarks().some((b) => b.page === page);
    items.push({
      label: marked ? `Remover marcador da página ${page}` : `Marcar a página ${page}`,
      icon: 'bookmark',
      onClick: () => {
        if (page !== this.viewer.currentPage) this.viewer.goToPage(page, { instant: true });
        this.toggleBookmark();
      }
    });
    contextMenu(items, e.clientX, e.clientY);
  }

  async speakSelection(text) {
    if (this.narrator && this.narrator.state !== 'idle') this.narrator.pause();
    const cfg = this.narrationConfig();
    if (!cfg.voice) return;
    let spoken = text;
    if (cfg.translateTo) {
      try { spoken = (await window.api.translate.text({ text, from: cfg.bookLang || 'auto', to: cfg.translateTo })).text; } catch (err) { toast(err.message, { type: 'error' }); return; }
    }
    if (this.narrator) this.narrator.stop();
    engines[cfg.engine].speak(spoken, { voice: cfg.voice, lang: cfg.voiceLocale, rate: cfg.rate, pitch: cfg.pitch, volume: cfg.volume }, {
      onError: (err) => toast(err.message, { type: 'error' })
    });
  }

  async translateSelection(text, x, y) {
    const cfg = this.narrationConfig();
    const bookLang = this.bookLang();
    let target = cfg.translateTo;
    if (!target) target = bookLang === 'pt' ? 'en' : 'pt';
    const pop = h('div.popover.translate-pop', {},
      h('div.popover-head', {}, h('h3', { text: `Tradução para ${langName(target)}` }), h('button.icon-btn', { title: 'Fechar', html: icon('x'), onclick: () => pop.remove() })),
      h('div.tp-orig', { text: text.length > 400 ? `${text.slice(0, 400)}…` : text }),
      h('div.tp-text', {}, h('span.sub-loading', { text: 'Traduzindo…' }))
    );
    document.body.append(pop);
    const place = () => {
      pop.style.left = `${Math.min(x, window.innerWidth - pop.offsetWidth - 12)}px`;
      pop.style.top = `${Math.min(y + 12, window.innerHeight - pop.offsetHeight - 12)}px`;
    };
    place();
    const closeOnOutside = (ev) => {
      if (!pop.contains(ev.target)) {
        pop.remove();
        document.removeEventListener('mousedown', closeOnOutside, true);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', closeOnOutside, true), 0);
    try {
      const res = await window.api.translate.text({ text, from: bookLang ? translationCode(bookLang) : 'auto', to: target });
      const box = pop.querySelector('.tp-text');
      box.textContent = res.text;
      const engineList = this.voiceLists[store.settings.engine] || [];
      const voice = this.voicesFor(engineList, target)[0];
      pop.append(h('div.tp-actions', {},
        h('button.btn.btn-ghost', { html: `${icon('copy')}Copiar`, onclick: () => { navigator.clipboard.writeText(res.text); toast('Tradução copiada.', { duration: 1500 }); } }),
        voice ? h('button.btn.btn-soft', {
          html: `${icon('volume')}Ouvir`,
          onclick: () => {
            if (this.narrator && this.narrator.state !== 'idle') this.narrator.stop();
            engines[store.settings.engine].speak(res.text, { voice: voice.id, lang: voice.locale, rate: store.settings.rate, pitch: store.settings.pitch, volume: store.settings.volume }, {});
          }
        }) : null
      ));
      hydrateIcons(pop);
      place();
    } catch (err) {
      pop.querySelector('.tp-text').textContent = err.message;
    }
  }

  // ======================================================
  // Exportar audiolivro (MP3)
  // ======================================================
  async openExport() {
    if (!this.viewer) return;
    const total = this.pdf.numPages;
    const cur = this.viewer.currentPage;
    let edgeVoices = [];
    try {
      edgeVoices = await this.getVoices('edge');
    } catch (err) {
      toast(`A exportação usa as vozes neurais online, que estão indisponíveis agora (${err.message}).`, { type: 'error' });
      return;
    }
    const lang = this.audioLangCode();
    const voices = this.voicesFor(edgeVoices, lang);
    if (!voices.length) {
      toast(`Nenhuma voz neural para ${langName(lang)}.`, { type: 'error' });
      return;
    }
    const savedEdge = store.settings.voiceByLang?.[`edge:${baseLang(lang)}`];
    const fromInput = h('input', { type: 'text', value: String(cur), inputmode: 'numeric' });
    const nextChapter = this.chapterPages.find((p) => p > cur);
    const toInput = h('input', { type: 'text', value: String(nextChapter ? nextChapter - 1 : Math.min(total, cur + 9)), inputmode: 'numeric' });
    const voiceSel = h('select', {}, ...voices.map((v) => h('option', { value: v.id, text: `${v.name} — ${langName(v.locale)} (${GENDER[v.gender] || v.gender})`, selected: v.id === savedEdge })));
    const cfg = this.narrationConfig();
    const info = h('p.small', { text: cfg.translateTo ? `O texto será traduzido para ${langName(cfg.translateTo)} antes de gerar o áudio.` : 'O áudio será gerado no idioma original do texto.' });
    const bar = h('div.progress-bar', {}, h('div'));
    const status = h('div.small.muted', { text: '' });
    const progressBox = h('div', { hidden: true, style: { display: 'flex', flexDirection: 'column', gap: '6px' } }, bar, status);
    const startBtn = h('button.btn.btn-primary', { html: `${icon('download')}Gerar MP3` });
    const cancelBtn = h('button.btn.btn-ghost', { text: 'Fechar' });
    let job = null;
    const content = h('div', { style: { display: 'contents' } },
      h('h2', { text: 'Gerar audiolivro (MP3)' }),
      h('p', { text: 'Transforme um trecho do livro em um arquivo de áudio para ouvir no celular, no carro ou onde quiser.' }),
      h('div.field-row', {},
        h('label.field', {}, h('span.field-label', { text: 'Da página' }), fromInput),
        h('label.field', {}, h('span.field-label', { text: `Até a página (máx. ${total})` }), toInput)
      ),
      h('label.field', {}, h('span.field-label', { text: 'Voz neural' }), voiceSel),
      info,
      h('p.small.muted', { text: `Velocidade: ${String(store.settings.rate).replace('.', ',')}x (a mesma da narração).` }),
      progressBox,
      h('div.modal-actions', {}, cancelBtn, startBtn)
    );
    const ref = openModal(content, { dismissable: true, onClose: () => { if (job) job.cancelled = true; } });
    cancelBtn.addEventListener('click', () => ref.close());
    startBtn.addEventListener('click', async () => {
      const from = Math.max(1, Math.min(total, parseInt(fromInput.value, 10) || cur));
      const to = Math.max(from, Math.min(total, parseInt(toInput.value, 10) || from));
      const target = await window.api.exporter.begin({ suggestedName: `${this.book.title} - páginas ${from}-${to}` });
      if (!target) return;
      job = { cancelled: false };
      startBtn.disabled = true;
      cancelBtn.textContent = 'Cancelar';
      progressBox.hidden = false;
      const voice = voiceSel.value;
      const rate = Math.round((store.settings.rate - 1) * 100);
      let chunks = 0;
      try {
        let pos = await this.bookText.firstFrom(from);
        let batch = '';
        const flush = async () => {
          if (!batch.trim()) return;
          const { audio } = await window.api.tts.synthesize({ text: batch, voice, pitch: store.settings.pitch, rate });
          await window.api.exporter.append(target.id, audio);
          chunks++;
          batch = '';
        };
        while (pos && pos.page <= to) {
          if (job.cancelled) throw new Error('cancelado');
          const s = await this.bookText.sentenceAt(pos);
          let text = s.text;
          if (cfg.translateTo) text = (await window.api.translate.text({ text, from: cfg.bookLang || 'auto', to: cfg.translateTo })).text;
          if (batch.length + text.length > 900) await flush();
          batch += `${batch ? ' ' : ''}${text}`;
          const pct = Math.round(((pos.page - from) / Math.max(1, to - from + 1)) * 100);
          bar.firstElementChild.style.width = `${pct}%`;
          status.textContent = `Gerando a página ${pos.page} de ${to}…`;
          pos = await this.bookText.next(pos);
        }
        await flush();
        await window.api.exporter.end(target.id);
        bar.firstElementChild.style.width = '100%';
        ref.close();
        if (!chunks) {
          toast('Não havia texto nessas páginas para gerar áudio.', { type: 'error' });
        } else {
          toast('Audiolivro gerado com sucesso!', { duration: 8000, action: { label: 'Mostrar arquivo', onClick: () => window.api.exporter.reveal(target.filePath) } });
        }
      } catch (err) {
        await window.api.exporter.end(target.id, { cancel: true });
        if (err.message !== 'cancelado') {
          status.textContent = `Erro: ${err.message}`;
          toast(`Falha ao gerar o audiolivro: ${err.message}`, { type: 'error' });
        } else {
          toast('Geração do audiolivro cancelada.');
        }
        startBtn.disabled = false;
      } finally {
        job = null;
        cancelBtn.textContent = 'Fechar';
      }
    });
  }

  // ======================================================
  // Atalhos de teclado
  // ======================================================
  showShortcuts() {
    const rows = [
      ['Espaço', 'Ouvir / pausar a narração'],
      ['Ctrl + → / Ctrl + ←', 'Próxima / frase anterior'],
      ['Clique numa frase', 'Durante a narração, continua a leitura dali'],
      ['Botão direito', 'Ouvir a partir daqui, traduzir ou ouvir uma seleção'],
      ['Page Down / Page Up', 'Próxima / página anterior'],
      ['Home / End', 'Primeira / última página'],
      ['Ctrl + roda do mouse', 'Zoom'],
      ['Ctrl + + / Ctrl + - / Ctrl + 0', 'Aumentar / diminuir / ajustar à largura'],
      ['Ctrl + F', 'Buscar no livro'],
      ['Ctrl + B', 'Marcar / desmarcar a página atual'],
      ['S', 'Mostrar / ocultar a legenda'],
      ['V', 'Painel de voz e idioma'],
      ['F11', 'Tela cheia'],
      ['Teclas de mídia', 'Play/pause, próxima e anterior (com a narração ativa)']
    ];
    const grid = h('div.kbd-grid');
    for (const [k, d] of rows) grid.append(h('div', {}, ...k.split(' / ').flatMap((part, i) => [i ? ' / ' : '', h('kbd', { text: part })])), h('div', { text: d }));
    const content = h('div', { style: { display: 'contents' } },
      h('h2', { text: 'Atalhos de teclado' }),
      grid,
      h('div.modal-actions', {}, h('button.btn.btn-primary', { text: 'Entendi', onclick: () => ref.close() }))
    );
    const ref = openModal(content);
  }

  onKey(e) {
    if (!this.book || this.root.hidden) return;
    if (document.querySelector('.modal-backdrop')) return;
    const typing = isTypingTarget(e.target);
    const key = e.key;
    if (key === 'Escape') {
      if (isPopoverOpen()) {
        hideAllPopovers();
        e.preventDefault();
      }
      return;
    }
    if (e.ctrlKey && key.toLowerCase() === 'f') {
      e.preventDefault();
      this.openSearch();
      return;
    }
    if (e.ctrlKey && key.toLowerCase() === 'b') {
      e.preventDefault();
      this.toggleBookmark();
      return;
    }
    if (e.ctrlKey && (key === '+' || key === '=')) { e.preventDefault(); this.viewer?.zoomBy(1.15); return; }
    if (e.ctrlKey && key === '-') { e.preventDefault(); this.viewer?.zoomBy(1 / 1.15); return; }
    if (e.ctrlKey && key === '0') { e.preventDefault(); this.viewer?.setZoom('width'); return; }
    if (key === 'F11') { e.preventDefault(); window.api.app.toggleFullscreen(); return; }
    if (typing) return;
    if (key === ' ' || key === 'MediaPlayPause') {
      e.preventDefault();
      this.togglePlay();
    } else if (e.ctrlKey && key === 'ArrowRight') {
      e.preventDefault();
      this.stepSentence(1);
    } else if (e.ctrlKey && key === 'ArrowLeft') {
      e.preventDefault();
      this.stepSentence(-1);
    } else if (key === 'PageDown' || (key === 'ArrowRight' && !e.ctrlKey)) {
      e.preventDefault();
      this.viewer?.goToPage(this.viewer.currentPage + 1);
    } else if (key === 'PageUp' || (key === 'ArrowLeft' && !e.ctrlKey)) {
      e.preventDefault();
      this.viewer?.goToPage(this.viewer.currentPage - 1);
    } else if (key === 'Home' && !e.ctrlKey) {
      e.preventDefault();
      this.viewer?.goToPage(1);
    } else if (key === 'End' && !e.ctrlKey) {
      e.preventDefault();
      this.viewer?.goToPage(this.pdf.numPages);
    } else if (key === '?') {
      this.showShortcuts();
    } else if (key.toLowerCase() === 's' && !e.ctrlKey && !e.altKey) {
      $('#btn-subtitle', this.root).click();
    } else if (key.toLowerCase() === 'v' && !e.ctrlKey && !e.altKey) {
      this.toggleVoicePanel();
    }
  }
}

