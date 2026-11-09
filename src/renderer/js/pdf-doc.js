// Carregamento de PDFs (pdf.js) e modelo de texto: páginas -> linhas -> frases,
// mantendo o mapeamento de cada caractere até o span do textLayer (para o destaque).

import * as pdfjsLib from '../../../node_modules/pdfjs-dist/build/pdf.mjs';

export { pdfjsLib };

const PDFJS_BASE = new URL('../../../node_modules/pdfjs-dist/', import.meta.url).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}build/pdf.worker.mjs`;

export async function openPdf(bytes) {
  const task = pdfjsLib.getDocument({
    data: bytes,
    cMapUrl: `${PDFJS_BASE}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${PDFJS_BASE}standard_fonts/`,
    wasmUrl: `${PDFJS_BASE}wasm/`,
    iccUrl: `${PDFJS_BASE}iccs/`,
    isEvalSupported: false,
    enableXfa: false
  });
  return task.promise;
}

const PARA = '\u2029'; // separador de parágrafo (força quebra de frase)
const TERMINATED_RE = /[.!?…:;]["'”’»)\]]*$/;
const ABBREVIATIONS = new Set([
  'sr', 'sra', 'srta', 'dr', 'dra', 'prof', 'profa', 'mr', 'mrs', 'ms', 'st', 'jr', 'av', 'etc', 'vs', 'cf',
  'p', 'pp', 'vol', 'cap', 'fig', 'ex', 'n', 'nº', 'art', 'séc', 'ed', 'eds', 'inc', 'ltd', 'co', 'no',
  'sec', 'pág', 'págs', 'obs', 'op', 'cit', 'ibid', 'id', 'aprox', 'tel', 'dept', 'gen', 'gov', 'sta', 'sto',
  'mt', 'lt', 'col', 'cia', 'ltda', 'sras', 'srs', 'drs', 'exmo', 'v', 'e.g', 'i.e', 'a.c', 'd.c'
]);
const MAX_SENTENCE = 420;

function itemHeight(item) {
  return item.height || Math.hypot(item.transform[2], item.transform[3]) || 10;
}

function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/**
 * Constrói o texto "bruto" de uma página a partir dos itens do pdf.js.
 * Cada caractere de `raw` aponta para (item, deslocamento) ou -1 quando é um separador inserido.
 */
export function buildPageText(textContent) {
  const items = textContent.items.filter((it) => it.str !== undefined);

  // 1) Agrupa itens em linhas.
  const lines = [];
  let cur = null;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const y = it.transform[5];
    const hgt = itemHeight(it);
    if (cur && cur.items.length) {
      const prev = items[cur.items[cur.items.length - 1]];
      const jump = Math.abs(prev.transform[5] - y) > Math.max(hgt, itemHeight(prev)) * 0.6;
      if (jump && !prev.hasEOL) {
        lines.push(cur);
        cur = null;
      }
    }
    if (!cur) cur = { items: [], y, h: 0, x0: Infinity, x1: -Infinity, text: '' };
    cur.items.push(i);
    if (it.str.trim()) {
      cur.h = Math.max(cur.h, hgt);
      cur.x0 = Math.min(cur.x0, it.transform[4]);
      cur.x1 = Math.max(cur.x1, it.transform[4] + (it.width || 0));
    }
    cur.text += it.str;
    if (it.hasEOL) {
      lines.push(cur);
      cur = null;
    }
  }
  if (cur && cur.items.length) lines.push(cur);
  const textLines = lines.filter((l) => l.text.trim());

  // 2) Estatísticas da página para decidir parágrafos.
  const gaps = [];
  for (let k = 0; k + 1 < textLines.length; k++) {
    const gap = textLines[k].y - textLines[k + 1].y;
    if (gap > 0 && gap < textLines[k].h * 3) gaps.push(gap);
  }
  const medianGap = median(gaps) || 14;
  const medianWidth = median(textLines.map((l) => l.x1 - l.x0)) || 1;
  const pageNumberRe = /^\s*[-–—]?\s*(\d{1,4}|[ivxlcdm]{1,7})\s*[-–—]?\s*$/i;

  const lineIndex = new Map(textLines.map((l, idx) => [l, idx]));
  const isParagraphAfter = (line) => {
    const idx = lineIndex.get(line);
    if (idx === undefined) return false;
    const next = textLines[idx + 1];
    if (!next) return true;
    const text = line.text.trim();
    const nextText = next.text.trim();
    const gap = line.y - next.y;
    if (gap < -line.h * 0.5) return true; // nova coluna
    if (gap > medianGap * 1.45 && gap > line.h * 1.15) return true;
    if (line.h && next.h && Math.abs(line.h - next.h) / Math.max(line.h, next.h) > 0.22) return true; // título
    if (pageNumberRe.test(text) || pageNumberRe.test(nextText)) return true;
    const short = line.x1 - line.x0 < medianWidth * 0.6;
    if (short && !/[,;:\-–—]$/.test(text) && /^[\p{Lu}\d"“«(]/u.test(nextText) && !TERMINATED_RE.test(text)) return true;
    // Cabeçalho/rodapé curto no topo da página.
    if (idx === 0 && short && gap > medianGap * 1.15) return true;
    return false;
  };

  // 3) Monta o texto com o mapa de caracteres.
  const chars = [];
  const itemOf = [];
  const offOf = [];
  const itemStart = new Array(items.length).fill(-1);
  const lineRanges = [];
  const push = (ch, item, off) => {
    chars.push(ch);
    itemOf.push(item);
    offOf.push(off);
  };

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const lineStart = chars.length;
    let prevItem = null;
    for (const i of line.items) {
      const it = items[i];
      if (prevItem && it.str) {
        const lastCh = chars[chars.length - 1];
        const gapX = it.transform[4] - (prevItem.transform[4] + (prevItem.width || 0));
        if (lastCh && !/\s/.test(lastCh) && !/^\s/.test(it.str) && gapX > itemHeight(prevItem) * 0.18) {
          push(' ', -1, 0);
        }
      }
      itemStart[i] = chars.length;
      for (let k = 0; k < it.str.length; k++) push(it.str[k], i, k);
      if (it.str) prevItem = it;
    }
    const lineEnd = chars.length;
    if (line.text.trim()) {
      lineRanges.push({ start: lineStart, end: lineEnd, text: line.text.trim(), y: line.y, h: line.h });
    }
    if (li < lines.length - 1) push(isParagraphAfter(line) ? PARA : '\n', -1, 0);
  }

  return {
    textContent,
    items,
    raw: chars.join(''),
    itemOf: Int32Array.from(itemOf),
    offOf: Int32Array.from(offOf),
    itemStart,
    lines: lineRanges,
    hasText: lineRanges.length > 0
  };
}

function letterCount(str) {
  return (str.match(/[\p{L}\p{N}]/gu) || []).length;
}

/** Divide o texto de uma página em frases (intervalos no texto bruto). */
export function segmentPage(pt, lang, skipRanges = []) {
  const raw = pt.raw;
  if (!raw) return [];
  const segText = raw.replace(/\n/g, ' ');
  let segmenter;
  try {
    segmenter = new Intl.Segmenter(lang || 'en', { granularity: 'sentence' });
  } catch {
    segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
  }
  let pieces = [];
  for (const { segment, index } of segmenter.segment(segText)) {
    let s = index;
    let e = index + segment.length;
    while (s < e && /[\s\u2029]/.test(segText[s])) s++;
    while (e > s && /[\s\u2029]/.test(segText[e - 1])) e--;
    if (e <= s) continue;
    pieces.push({ start: s, end: e });
  }

  // Junta abreviações, iniciais e pedaços muito curtos à frase seguinte.
  const merged = [];
  for (let i = 0; i < pieces.length; i++) {
    let p = { ...pieces[i] };
    while (i + 1 < pieces.length) {
      const text = segText.slice(p.start, p.end);
      const between = segText.slice(p.end, pieces[i + 1].start);
      if (between.includes(PARA)) break;
      const lastWord = (/([\p{L}.º]+)\.$/u.exec(text) || [])[1];
      const isAbbrev = lastWord && (ABBREVIATIONS.has(lastWord.toLowerCase()) || /^\p{Lu}$/u.test(lastWord));
      const tooShort = letterCount(text) < 3 && !/^\d{1,4}$/.test(text.trim());
      if (!isAbbrev && !tooShort) break;
      p = { start: p.start, end: pieces[i + 1].end };
      i++;
    }
    merged.push(p);
  }
  pieces = merged;

  // Quebra frases longas demais (listas, tabelas) em pontos naturais.
  const result = [];
  for (const p of pieces) {
    let { start } = p;
    while (p.end - start > MAX_SENTENCE) {
      const chunk = segText.slice(start, start + MAX_SENTENCE);
      let cut = -1;
      for (const sep of ['; ', ': ', ', ', ' — ', ' – ', ' ']) {
        const idx = chunk.lastIndexOf(sep);
        if (idx > 160) {
          cut = idx + sep.length - 1;
          break;
        }
      }
      if (cut < 0) cut = MAX_SENTENCE;
      let end = start + cut;
      while (end > start && /\s/.test(segText[end - 1])) end--;
      result.push({ start, end });
      start += cut;
      while (start < p.end && /\s/.test(segText[start])) start++;
    }
    if (p.end > start) result.push({ start, end: p.end });
  }

  // Remove trechos sem conteúdo legível, números de página e cabeçalhos repetidos.
  return result.filter((p) => {
    const text = raw.slice(p.start, p.end).trim();
    if (letterCount(text) === 0) return false;
    if (/^[-–—]?\s*(\d{1,4}|[ivxlcdm]{1,7})\s*[-–—]?$/i.test(text)) return false;
    if (skipRanges.some((r) => p.start >= r.start && p.end <= r.end)) return false;
    return true;
  });
}

/**
 * Monta o texto falado de uma frase, juntando hifenizações de fim de linha,
 * colapsando espaços e guardando o mapa (caractere falado -> página/posição bruta).
 */
export function buildSpokenText(segments, getPageText) {
  const out = [];
  const mapPage = [];
  const mapRaw = [];
  let pendingSpace = null;
  for (let si = 0; si < segments.length; si++) {
    const seg = segments[si];
    const raw = getPageText(seg.page).raw;
    if (si > 0 && out.length) {
      // Junção entre páginas: "conti-" + "nuação" vira "continuação".
      const first = raw.slice(seg.start, seg.start + 1);
      if (out[out.length - 1] === '-' && /\p{Ll}/u.test(first)) {
        out.pop(); mapPage.pop(); mapRaw.pop();
        pendingSpace = null;
      } else {
        pendingSpace = { page: seg.page, raw: seg.start };
      }
    }
    for (let i = seg.start; i < seg.end; i++) {
      const ch = raw[i];
      if (ch === '­') continue;
      if ((ch === '-' || ch === '‐') && (raw[i + 1] === '\n') && /\p{Ll}/u.test(raw[i + 2] || '')) {
        i += 1; // pula o hífen e a quebra de linha
        continue;
      }
      if (/[\s\u2029]/.test(ch)) {
        if (out.length && !pendingSpace) pendingSpace = { page: seg.page, raw: i };
        continue;
      }
      if (pendingSpace) {
        out.push(' ');
        mapPage.push(pendingSpace.page);
        mapRaw.push(pendingSpace.raw);
        pendingSpace = null;
      }
      out.push(ch);
      mapPage.push(seg.page);
      mapRaw.push(i);
    }
  }
  return { text: out.join(''), mapPage, mapRaw };
}

/** Converte um intervalo do texto falado em intervalos brutos por página. */
export function spokenRangeToRaw(sentence, start, end) {
  const ranges = [];
  for (let i = Math.max(0, start); i < Math.min(end, sentence.mapRaw.length); i++) {
    const page = sentence.mapPage[i];
    const r = sentence.mapRaw[i];
    const last = ranges[ranges.length - 1];
    if (last && last.page === page && r >= last.end - 1 && r <= last.end + 3) {
      last.end = Math.max(last.end, r + 1);
    } else {
      ranges.push({ page, start: r, end: r + 1 });
    }
  }
  return ranges;
}

const normKey = (s) => s.toLowerCase().replace(/[\d\s]+/g, '').slice(0, 80);

/** Modelo de texto do livro inteiro, carregado sob demanda e com cache. */
export class BookText {
  constructor(pdf, lang = 'en') {
    this.pdf = pdf;
    this.numPages = pdf.numPages;
    this.lang = lang;
    this.pages = new Map(); // página -> Promise<PageText>
    this.resolved = new Map(); // página -> PageText
    this.sentenceCache = new Map(); // página -> Promise<Sentence[]>
  }

  setLanguage(lang) {
    if (lang && lang !== this.lang) {
      this.lang = lang;
      this.sentenceCache.clear();
    }
  }

  getPage(n) {
    if (n < 1 || n > this.numPages) return Promise.resolve(null);
    let p = this.pages.get(n);
    if (!p) {
      p = this.pdf.getPage(n)
        .then((page) => page.getTextContent({ includeMarkedContent: true }))
        .then((tc) => {
          const pt = buildPageText(tc);
          pt.page = n;
          this.resolved.set(n, pt);
          return pt;
        })
        .catch((err) => {
          console.error('Falha ao extrair texto da página', n, err);
          const empty = { page: n, raw: '', items: [], itemOf: new Int32Array(), offOf: new Int32Array(), itemStart: [], lines: [], hasText: false, textContent: { items: [], styles: {} } };
          this.resolved.set(n, empty);
          return empty;
        });
      this.pages.set(n, p);
    }
    return p;
  }

  pageTextSync(n) {
    return this.resolved.get(n);
  }

  /** Detecta cabeçalhos/rodapés repetidos comparando com as páginas vizinhas. */
  async _skipRanges(n, pt) {
    if (!pt.lines.length) return [];
    const neighbors = (await Promise.all([this.getPage(n - 1), this.getPage(n + 1), this.getPage(n - 2), this.getPage(n + 2)])).filter(Boolean);
    const ranges = [];
    const check = (line, pick) => {
      const key = normKey(line.text);
      if (key.length < 3 || line.text.length > 90) return;
      const repeated = neighbors.filter((nb) => nb.lines.length && normKey(pick(nb).text) === key).length;
      if (repeated >= 1) ranges.push({ start: line.start, end: line.end });
    };
    check(pt.lines[0], (nb) => nb.lines[0]);
    if (pt.lines.length > 1) check(pt.lines[pt.lines.length - 1], (nb) => nb.lines[nb.lines.length - 1]);
    return ranges;
  }

  async _pieces(n) {
    const pt = await this.getPage(n);
    if (!pt || !pt.hasText) return { pt, pieces: [] };
    const skip = await this._skipRanges(n, pt);
    return { pt, pieces: segmentPage(pt, this.lang, skip) };
  }

  /** Frases que COMEÇAM na página n (a última pode continuar na página seguinte). */
  getSentences(n) {
    if (n < 1 || n > this.numPages) return Promise.resolve([]);
    let p = this.sentenceCache.get(n);
    if (!p) {
      p = this._computeSentences(n);
      this.sentenceCache.set(n, p);
    }
    return p;
  }

  async _computeSentences(n) {
    const { pt, pieces } = await this._pieces(n);
    if (!pieces.length) return [];
    let list = pieces.map((piece) => ({ segments: [{ page: n, start: piece.start, end: piece.end }] }));

    // A primeira frase continua a última da página anterior?
    if (n > 1) {
      const prev = await this._pieces(n - 1);
      const last = prev.pieces[prev.pieces.length - 1];
      if (last && !TERMINATED_RE.test(prev.pt.raw.slice(last.start, last.end).trim())) {
        list[0].continuation = true;
      }
    }
    // A última frase termina na próxima página?
    const lastPiece = pieces[pieces.length - 1];
    const lastText = pt.raw.slice(lastPiece.start, lastPiece.end).trim();
    if (n < this.numPages && !TERMINATED_RE.test(lastText)) {
      const next = await this._pieces(n + 1);
      if (next.pieces.length) {
        const nf = next.pieces[0];
        list[list.length - 1].segments.push({ page: n + 1, start: nf.start, end: nf.end });
      }
    }
    // Se a primeira frase pertence à página anterior, ela é lida lá
    // (mas o trecho que ela eventualmente puxa da página seguinte continua sendo nosso).
    const continuation = list.find((s) => s.continuation) || null;
    const owned = [];
    for (const s of list) {
      if (!s.continuation) owned.push(s);
      else if (s.segments.length > 1) owned.push({ segments: s.segments.slice(1) });
    }

    const sentences = owned.map((s, index) => {
      const spoken = buildSpokenText(s.segments, (pg) => this.pageTextSync(pg));
      return {
        key: `${n}:${index}`,
        page: n,
        index,
        segments: s.segments,
        text: spoken.text,
        mapPage: spoken.mapPage,
        mapRaw: spoken.mapRaw
      };
    }).filter((s) => s.text.trim());
    sentences.continuationRange = continuation ? continuation.segments[0] : null;
    sentences.forEach((s, i) => { s.index = i; s.key = `${n}:${i}`; });
    return sentences;
  }

  async sentenceAt(pos) {
    if (!pos) return null;
    const list = await this.getSentences(pos.page);
    return list[pos.index] || null;
  }

  async next(pos) {
    const list = await this.getSentences(pos.page);
    if (pos.index + 1 < list.length) return { page: pos.page, index: pos.index + 1 };
    for (let p = pos.page + 1; p <= this.numPages; p++) {
      const l = await this.getSentences(p);
      if (l.length) return { page: p, index: 0 };
    }
    return null;
  }

  async prev(pos) {
    if (pos.index > 0) return { page: pos.page, index: pos.index - 1 };
    for (let p = pos.page - 1; p >= 1; p--) {
      const l = await this.getSentences(p);
      if (l.length) return { page: p, index: l.length - 1 };
    }
    return null;
  }

  /** Primeira frase a partir da página n (inclusive). */
  async firstFrom(n) {
    for (let p = Math.max(1, n); p <= this.numPages; p++) {
      const l = await this.getSentences(p);
      if (l.length) return { page: p, index: 0 };
    }
    return null;
  }

  /** Frase que contém a posição bruta `offset` da página n. */
  async locate(n, offset) {
    const list = await this.getSentences(n);
    for (const s of list) {
      for (const seg of s.segments) {
        if (seg.page === n && offset >= seg.start && offset < seg.end) return { page: n, index: s.index };
      }
    }
    const cont = list.continuationRange;
    if (cont && offset < cont.end && n > 1) {
      const prevList = await this.getSentences(n - 1);
      if (prevList.length) return { page: n - 1, index: prevList.length - 1 };
    }
    const after = list.find((s) => s.segments[0].page === n && s.segments[0].start >= offset);
    if (after) return { page: n, index: after.index };
    return this.firstFrom(n + 1);
  }

  /** Texto simples de uma página (para busca, marcadores e detecção de idioma). */
  async plainText(n) {
    const pt = await this.getPage(n);
    return pt ? pt.raw.replace(/[\n\u2029]/g, ' ') : '';
  }
}
