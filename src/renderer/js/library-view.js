// Tela da biblioteca: estante, busca, filtros, cadastro e processamento de novos livros.

import { store } from './store.js';
import {
  $, $$, h, icon, hydrateIcons, toast, openModal, confirmDialog, contextMenu,
  formatRelative, formatDuration, formatSize, colorFromString, debounce
} from './ui.js';
import { openPdf, BookText } from './pdf-doc.js';
import { detectLanguage, langName, BOOK_LANGUAGES } from './lang.js';

const processing = new Set();

function coverUrl(book) {
  return book.coverVersion ? `app://covers/${book.id}.png?v=${book.coverVersion}` : null;
}

function cleanMetaTitle(title) {
  const t = String(title || '').replace(/\s+/g, ' ').trim();
  if (t.length < 3 || t.length > 160) return null;
  if (/^(untitled|sem t[ií]tulo|document|documento|microsoft word|title|untitled document)\b/i.test(t)) return null;
  if (/\.(docx?|pdf|indd|tex|odt|rtf|txt|p65|qxd)$/i.test(t)) return null;
  if (/^[\w-]+$/.test(t) && /\d{3,}/.test(t)) return null; // nomes de arquivo técnicos
  return t;
}

/** Lê metadados, gera a capa e detecta o idioma de um livro recém-adicionado. */
export async function processBook(book) {
  if (processing.has(book.id)) return;
  processing.add(book.id);
  let pdf = null;
  const patch = { needsProcessing: false };
  try {
    const bytes = await window.api.library.readPdf(book.id);
    pdf = await openPdf(bytes);
    patch.pageCount = pdf.numPages;
    const meta = await pdf.getMetadata().catch(() => null);
    const title = cleanMetaTitle(meta?.info?.Title);
    if (title) patch.title = title;
    const author = String(meta?.info?.Author || '').replace(/\s+/g, ' ').trim();
    if (author && author.length < 120 && !/^(user|admin|usuário|autor|author|unknown)$/i.test(author)) patch.author = author;

    // Capa: primeira página renderizada em miniatura.
    try {
      const page = await pdf.getPage(1);
      const vp1 = page.getViewport({ scale: 1 });
      const scale = 340 / vp1.width;
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (blob) {
        const saved = await window.api.library.saveCover(book.id, new Uint8Array(await blob.arrayBuffer()));
        patch.coverVersion = saved.coverVersion;
      }
    } catch (err) {
      console.warn('Não foi possível gerar a capa', err);
    }

    // Idioma do texto.
    if (!book.language) {
      const bt = new BookText(pdf);
      let sample = '';
      const last = Math.min(pdf.numPages, 12);
      for (let p = Math.min(2, pdf.numPages); p <= last && sample.length < 8000; p++) sample += ` ${await bt.plainText(p)}`;
      if (sample.trim().length < 200) sample = `${await bt.plainText(1)} ${sample}`;
      let { lang, confidence } = detectLanguage(sample);
      if ((!lang || confidence < 0.25) && sample.trim().length > 30) {
        const online = await window.api.translate.detect(sample.slice(0, 600)).catch(() => null);
        if (online) lang = online.split('-')[0];
      }
      patch.language = lang || null;
      patch.hasText = sample.replace(/\s+/g, '').length > 30;
    }
  } catch (err) {
    console.error('Falha ao processar livro', err);
    toast(`Não foi possível ler "${book.title}": ${err.message}`, { type: 'error' });
  } finally {
    try { await pdf?.destroy(); } catch { /* ignora */ }
    processing.delete(book.id);
  }
  await store.updateBook(book.id, patch);
}

export class LibraryView {
  constructor(root, { onOpen }) {
    this.root = root;
    this.onOpen = onOpen;
    this.query = '';
    this.grid = $('#lib-grid', root);
    $('#btn-add-books', root).addEventListener('click', () => this.pickBooks());
    $('#btn-add-empty', root).addEventListener('click', () => this.pickBooks());
    $('#lib-search', root).addEventListener('input', debounce((e) => {
      this.query = e.target.value.trim();
      this.render();
    }, 120));
    $('#lib-sort', root).addEventListener('change', (e) => store.updateSettings({ librarySort: e.target.value }));
    $$('#lib-filter button', root).forEach((btn) => btn.addEventListener('click', () => store.updateSettings({ libraryFilter: btn.dataset.filter })));
    store.addEventListener('books', () => this.render());
    store.addEventListener('settings', (e) => {
      const patch = e.detail?.patch;
      if (!patch || 'librarySort' in patch || 'libraryFilter' in patch) this.render();
    });
  }

  async pickBooks() {
    const result = await window.api.library.pick();
    this.handleAdded(result);
  }

  async addPaths(paths) {
    if (!paths.length) return;
    const result = await window.api.library.addPaths(paths);
    this.handleAdded(result);
  }

  handleAdded(result) {
    const { added = [], skipped = [] } = result || {};
    if (added.length) {
      store.addBooks(added);
      toast(added.length === 1 ? `"${added[0].title}" foi adicionado à biblioteca.` : `${added.length} livros adicionados à biblioteca.`);
      this.processQueue(added);
    }
    for (const s of skipped.slice(0, 3)) {
      const name = s.path.split(/[\\/]/).pop();
      toast(`${name}: ${s.reason}.`, { type: skipped.length && !added.length ? 'error' : 'info' });
    }
    return result;
  }

  async processQueue(books) {
    for (const book of books) await processBook(store.getBook(book.id) || book);
  }

  /** Reprocessa livros que ficaram pendentes (ex.: app fechado durante a importação). */
  resumePending() {
    const pending = store.books.filter((b) => b.needsProcessing);
    if (pending.length) this.processQueue(pending);
  }

  filtered() {
    const { librarySort: sort, libraryFilter: filter } = store.settings;
    const q = this.query.toLocaleLowerCase('pt-BR').normalize('NFD').replace(/\p{M}/gu, '');
    let list = store.books.filter((b) => {
      if (filter === 'reading' && !(b.progress > 0 && !b.finished)) return false;
      if (filter === 'unread' && (b.progress > 0 || b.finished)) return false;
      if (filter === 'finished' && !b.finished) return false;
      if (filter === 'favorite' && !b.favorite) return false;
      if (!q) return true;
      const hay = `${b.title} ${b.author} ${b.fileName}`.toLocaleLowerCase('pt-BR').normalize('NFD').replace(/\p{M}/gu, '');
      return hay.includes(q);
    });
    const byText = (key) => (a, b) => String(a[key] || '￿').localeCompare(String(b[key] || '￿'), 'pt-BR', { sensitivity: 'base' });
    const sorters = {
      recent: (a, b) => (b.lastOpenedAt || b.addedAt / 1e3) - (a.lastOpenedAt || a.addedAt / 1e3),
      added: (a, b) => b.addedAt - a.addedAt,
      title: byText('title'),
      author: byText('author'),
      progress: (a, b) => (b.progress || 0) - (a.progress || 0)
    };
    list = list.slice().sort(sorters[sort] || sorters.recent);
    return list;
  }

  render() {
    const { librarySort, libraryFilter } = store.settings;
    $('#lib-sort', this.root).value = librarySort;
    $$('#lib-filter button', this.root).forEach((b) => b.classList.toggle('active', b.dataset.filter === libraryFilter));

    const total = store.books.length;
    const list = this.filtered();
    $('#lib-empty', this.root).hidden = total > 0;
    $('#lib-noresults', this.root).hidden = total === 0 || list.length > 0;
    $('.lib-toolbar', this.root).hidden = total === 0;
    $('#lib-count', this.root).textContent = total ? `${list.length} de ${total} ${total === 1 ? 'livro' : 'livros'}` : '';
    this.renderContinue();

    this.grid.replaceChildren(...list.map((b) => this.card(b)));
    hydrateIcons(this.grid);
  }

  renderContinue() {
    const box = $('#lib-continue', this.root);
    const recent = store.books
      .filter((b) => b.lastOpenedAt && !b.finished)
      .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)[0];
    if (!recent || this.query) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const pct = Math.round((recent.progress || 0) * 100);
    const url = coverUrl(recent);
    box.replaceChildren(
      h('div.cc-cover', {}, url ? h('img', { src: url, alt: '' }) : h('div', { style: { width: '100%', height: '100%', background: colorFromString(recent.title) } })),
      h('div.cc-body', {},
        h('div.cc-kicker', { text: 'Continuar de onde parou' }),
        h('div.cc-title', { text: recent.title, title: recent.title }),
        h('div.cc-meta', { text: `${recent.author ? `${recent.author} · ` : ''}Página ${recent.lastPage || 1} de ${recent.pageCount || '?'} · ${pct}% · aberto ${formatRelative(recent.lastOpenedAt)}` }),
        h('div.cc-progress', {}, h('div', { style: { width: `${pct}%` } }))
      ),
      h('div.cc-actions', {},
        h('button.btn.btn-ghost', { html: `${icon('book-open')}Ler`, onclick: () => this.onOpen(recent.id, { listen: false }) }),
        h('button.btn.btn-primary', { html: `${icon('headphones')}Continuar ouvindo`, onclick: () => this.onOpen(recent.id, { listen: true }) })
      )
    );
  }

  card(book) {
    const pct = Math.round((book.progress || 0) * 100);
    const url = coverUrl(book);
    const busy = book.needsProcessing || processing.has(book.id);
    const cover = h('div.book-cover', { title: book.title, onclick: () => this.onOpen(book.id, { listen: false }) });
    if (url) {
      cover.append(h('img', { src: url, alt: `Capa de ${book.title}`, loading: 'lazy', draggable: 'false' }));
    } else {
      const ph = h('div.cover-placeholder', { style: { background: colorFromString(book.title) } }, h('span', { text: book.title }));
      if (busy) ph.append(h('div.spinner'));
      cover.append(ph);
    }
    const badges = h('div.book-badges');
    if (book.finished) badges.append(h('span.badge.done', { text: 'Concluído' }));
    else if (pct > 0) badges.append(h('span.badge', { text: `${pct}%` }));
    if (book.language) badges.append(h('span.badge', { text: book.language.toUpperCase(), title: langName(book.language) }));
    cover.append(badges);
    const fav = h('button.fav-btn', {
      class: book.favorite ? 'on' : '',
      title: book.favorite ? 'Remover dos favoritos' : 'Adicionar aos favoritos',
      html: icon('star'),
      onclick: (e) => {
        e.stopPropagation();
        store.updateBook(book.id, { favorite: !book.favorite });
      }
    });
    cover.append(fav);
    cover.append(h('div.book-hover-actions', {},
      h('button.ha-read', { html: `${icon('book-open')}Ler`, onclick: (e) => { e.stopPropagation(); this.onOpen(book.id, { listen: false }); } }),
      h('button.ha-listen', { html: `${icon('headphones')}Ouvir`, onclick: (e) => { e.stopPropagation(); this.onOpen(book.id, { listen: true }); } })
    ));

    const menuBtn = h('button.icon-btn.book-menu-btn', { title: 'Mais opções', html: icon('more') });
    menuBtn.addEventListener('click', (e) => {
      const r = menuBtn.getBoundingClientRect();
      this.bookMenu(book, r.left - 160, r.bottom + 4);
      e.stopPropagation();
    });

    const meta = [];
    if (book.pageCount) meta.push(`${book.pageCount} págs.`);
    if (book.lastOpenedAt) meta.push(formatRelative(book.lastOpenedAt));
    else meta.push('novo');

    const card = h('div.book-card', { tabindex: '0', dataset: { id: book.id } },
      cover,
      h('div.book-progress', { title: `${pct}% lido` }, h('div', { style: { width: `${pct}%` } })),
      h('div.book-info', {},
        h('div.book-text', {},
          h('div.book-title', { text: book.title, title: book.title }),
          h('div.book-author', { text: book.author || 'Autor desconhecido' }),
          h('div.book-meta', { text: meta.join(' · ') })
        ),
        menuBtn
      )
    );
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.onOpen(book.id, { listen: false });
    });
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.bookMenu(book, e.clientX, e.clientY);
    });
    return card;
  }

  bookMenu(book, x, y) {
    contextMenu([
      { label: 'Abrir para ler', icon: 'book-open', onClick: () => this.onOpen(book.id, { listen: false }) },
      { label: 'Ouvir', icon: 'headphones', onClick: () => this.onOpen(book.id, { listen: true }) },
      '-',
      { label: 'Editar informações', icon: 'edit', onClick: () => this.editBook(book) },
      { label: 'Detalhes e estatísticas', icon: 'info', onClick: () => this.showDetails(book) },
      { label: book.finished ? 'Marcar como não concluído' : 'Marcar como concluído', icon: 'check', onClick: () => store.updateBook(book.id, { finished: !book.finished, progress: book.finished ? book.progress : 1 }) },
      { label: 'Regerar capa e idioma', icon: 'refresh', onClick: () => processBook({ ...book, language: null }) },
      { label: 'Mostrar arquivo no Explorer', icon: 'folder', onClick: () => window.api.library.reveal(book.id) },
      '-',
      { label: 'Remover da biblioteca', icon: 'trash', danger: true, onClick: () => this.removeBook(book) }
    ], x, y);
  }

  editBook(book) {
    const title = h('input', { type: 'text', value: book.title, autofocus: true });
    const author = h('input', { type: 'text', value: book.author || '', placeholder: 'Nome do autor' });
    const lang = h('select', {}, h('option', { value: '', text: 'Detectar automaticamente' }),
      ...BOOK_LANGUAGES.map((code) => h('option', { value: code, text: langName(code), selected: book.language === code })));
    const save = async () => {
      const patch = { title: title.value.trim() || book.title, author: author.value.trim(), language: lang.value || null };
      await store.updateBook(book.id, patch);
      ref.close();
      if (!patch.language) processBook({ ...store.getBook(book.id), language: null });
    };
    const content = h('div', { style: { display: 'contents' } },
      h('h2', { text: 'Editar informações' }),
      h('label.field', {}, h('span.field-label', { text: 'Título' }), title),
      h('label.field', {}, h('span.field-label', { text: 'Autor' }), author),
      h('label.field', {}, h('span.field-label', { text: 'Idioma do texto' }), lang),
      h('div.modal-actions', {},
        h('button.btn.btn-ghost', { text: 'Cancelar', onclick: () => ref.close() }),
        h('button.btn.btn-primary', { text: 'Salvar', onclick: save })
      )
    );
    content.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') save(); });
    const ref = openModal(content);
  }

  showDetails(book) {
    const pct = Math.round((book.progress || 0) * 100);
    const content = h('div', { style: { display: 'contents' } },
      h('h2', { text: book.title }),
      h('p', { text: book.author || 'Autor desconhecido' }),
      h('div.stat-grid', {},
        stat(`${pct}%`, 'lido'),
        stat(formatDuration(book.readingSeconds), 'tempo lendo'),
        stat(formatDuration(book.listeningSeconds), 'tempo ouvindo'),
        stat(book.pageCount || '—', 'páginas'),
        stat((book.bookmarks || []).length, 'marcadores'),
        stat(book.language ? langName(book.language) : '—', 'idioma')
      ),
      h('h4', { text: 'Arquivo' }),
      h('p.small', { text: `${book.fileName} · ${formatSize(book.size)}` }),
      h('p.small.muted', { text: `Adicionado em ${new Date(book.addedAt).toLocaleString('pt-BR')} · Último acesso: ${formatRelative(book.lastOpenedAt)}` }),
      h('div.modal-actions', {}, h('button.btn.btn-primary', { text: 'Fechar', onclick: () => ref.close() }))
    );
    const ref = openModal(content);
  }

  async removeBook(book) {
    const ok = await confirmDialog({
      title: 'Remover livro?',
      message: `"${book.title}" será removido da biblioteca, junto com marcadores e progresso. O arquivo original (${book.originalPath || book.fileName}) não será apagado.`,
      confirmLabel: 'Remover',
      danger: true
    });
    if (!ok) return;
    await store.removeBook(book.id);
    toast('Livro removido da biblioteca.');
  }
}

function stat(value, label) {
  return h('div.stat', {}, h('div.v', { text: String(value) }), h('div.l', { text: label }));
}
