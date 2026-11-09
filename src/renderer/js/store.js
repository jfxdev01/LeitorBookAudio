// Estado compartilhado: livros e configurações, sincronizados com o processo principal.

export const DEFAULT_SETTINGS = {
  theme: 'system', // system | light | dark
  engine: 'edge', // edge | system
  audioLang: 'same', // 'same' ou código de idioma (ex.: 'pt')
  voiceByLang: {}, // "engine:idioma" -> id da voz
  rate: 1,
  pitch: 0,
  volume: 1,
  wordHighlight: true,
  follow: true,
  subtitles: false,
  pdfTheme: 'normal', // normal | sepia | night
  translationProvider: 'google', // google | deepl | libre
  deeplKey: '',
  libreUrl: '',
  libreKey: '',
  librarySort: 'recent',
  libraryFilter: 'all',
  sidebarOpen: false,
  sidebarTab: 'outline'
};

class Store extends EventTarget {
  constructor() {
    super();
    this.books = [];
    this.settings = { ...DEFAULT_SETTINGS };
  }

  async load() {
    const [books, settings] = await Promise.all([window.api.library.list(), window.api.settings.get()]);
    this.books = books || [];
    this.settings = { ...DEFAULT_SETTINGS, ...(settings || {}) };
    this._emit('books');
    this._emit('settings');
  }

  _emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  getBook(id) {
    return this.books.find((b) => b.id === id) || null;
  }

  async updateBook(id, patch, { silent = false } = {}) {
    const local = this.getBook(id);
    if (local) Object.assign(local, patch);
    const saved = await window.api.library.update(id, patch);
    if (local && saved) Object.assign(local, saved);
    if (!silent) this._emit('books', { id });
    return local;
  }

  /** Atualiza só localmente e salva em segundo plano (para progresso de leitura). */
  patchBookQuiet(id, patch) {
    const local = this.getBook(id);
    if (local) Object.assign(local, patch);
    window.api.library.update(id, patch).catch((err) => console.error(err));
  }

  addBooks(books) {
    for (const b of books) if (!this.getBook(b.id)) this.books.push(b);
    this._emit('books');
  }

  async removeBook(id) {
    await window.api.library.remove(id);
    this.books = this.books.filter((b) => b.id !== id);
    this._emit('books', { id, removed: true });
  }

  replaceBook(book) {
    const idx = this.books.findIndex((b) => b.id === book.id);
    if (idx >= 0) this.books[idx] = { ...this.books[idx], ...book };
    this._emit('books', { id: book.id });
  }

  async updateSettings(patch) {
    this.settings = { ...this.settings, ...patch };
    this._emit('settings', { patch });
    await window.api.settings.set(patch);
  }
}

export const store = new Store();
