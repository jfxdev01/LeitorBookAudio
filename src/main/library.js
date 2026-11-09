'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');

/** Campos do livro que o renderer pode alterar. */
const EDITABLE_FIELDS = new Set([
  'title', 'author', 'pageCount', 'lastPage', 'lastPosition', 'progress', 'language',
  'bookmarks', 'favorite', 'readingSeconds', 'listeningSeconds', 'lastOpenedAt',
  'needsProcessing', 'finished', 'audioLang', 'zoom', 'tags'
]);

function sha1File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    fs.createReadStream(filePath)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

class Library {
  constructor(baseDir) {
    this.baseDir = baseDir;
    this.file = path.join(baseDir, 'library.json');
    this.booksDir = path.join(baseDir, 'books');
    this.coversDir = path.join(baseDir, 'covers');
    fs.mkdirSync(this.booksDir, { recursive: true });
    fs.mkdirSync(this.coversDir, { recursive: true });
    this.data = { version: 1, books: [], settings: {} };
    this._saveTimer = null;
    this._load();
  }

  _load() {
    try {
      if (!fs.existsSync(this.file)) return;
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (parsed && Array.isArray(parsed.books)) {
        this.data = { version: 1, books: parsed.books, settings: parsed.settings || {} };
      }
    } catch (err) {
      // Arquivo corrompido: guarda uma cópia e começa do zero, sem perder os PDFs.
      try { fs.copyFileSync(this.file, `${this.file}.corrompido-${Date.now()}`); } catch { /* ignora */ }
      console.error('Falha ao ler a biblioteca:', err);
    }
  }

  _scheduleSave() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._writeNow(), 400);
  }

  _writeNow() {
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
    const tmp = `${this.file}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('Falha ao salvar a biblioteca:', err);
    }
  }

  flush() {
    if (this._saveTimer) this._writeNow();
  }

  pdfPath(id) {
    return path.join(this.booksDir, `${path.basename(id)}.pdf`);
  }

  coverPath(fileName) {
    return path.join(this.coversDir, path.basename(fileName));
  }

  list() {
    return this.data.books;
  }

  get(id) {
    return this.data.books.find((b) => b.id === id) || null;
  }

  async addFiles(paths) {
    const added = [];
    const skipped = [];
    for (const original of paths) {
      try {
        if (!original.toLowerCase().endsWith('.pdf')) {
          skipped.push({ path: original, reason: 'não é um arquivo PDF' });
          continue;
        }
        const stat = await fsp.stat(original);
        if (!stat.isFile()) {
          skipped.push({ path: original, reason: 'não é um arquivo' });
          continue;
        }
        const hash = await sha1File(original);
        const existing = this.data.books.find((b) => b.hash === hash);
        if (existing) {
          skipped.push({ path: original, reason: `já está na biblioteca como "${existing.title}"`, id: existing.id });
          continue;
        }
        const id = crypto.randomUUID();
        await fsp.copyFile(original, this.pdfPath(id));
        const fileName = path.basename(original);
        const book = {
          id,
          title: fileName.replace(/\.pdf$/i, '').replace(/[_]+/g, ' ').trim(),
          author: '',
          fileName,
          originalPath: original,
          size: stat.size,
          hash,
          addedAt: Date.now(),
          lastOpenedAt: null,
          pageCount: 0,
          lastPage: 1,
          lastPosition: null,
          progress: 0,
          finished: false,
          language: null,
          audioLang: null,
          bookmarks: [],
          favorite: false,
          readingSeconds: 0,
          listeningSeconds: 0,
          coverVersion: 0,
          needsProcessing: true,
          tags: []
        };
        this.data.books.push(book);
        added.push(book);
      } catch (err) {
        skipped.push({ path: original, reason: err.message });
      }
    }
    if (added.length) this._scheduleSave();
    return { added, skipped };
  }

  update(id, patch) {
    const book = this.get(id);
    if (!book) throw new Error('Livro não encontrado');
    for (const [key, value] of Object.entries(patch || {})) {
      if (EDITABLE_FIELDS.has(key)) book[key] = value;
    }
    this._scheduleSave();
    return book;
  }

  async remove(id) {
    const idx = this.data.books.findIndex((b) => b.id === id);
    if (idx < 0) return false;
    this.data.books.splice(idx, 1);
    this._scheduleSave();
    await fsp.rm(this.pdfPath(id), { force: true });
    await fsp.rm(this.coverPath(`${id}.png`), { force: true });
    return true;
  }

  async readPdf(id) {
    if (!this.get(id)) throw new Error('Livro não encontrado');
    return fsp.readFile(this.pdfPath(id));
  }

  async saveCover(id, bytes) {
    const book = this.get(id);
    if (!book) throw new Error('Livro não encontrado');
    await fsp.writeFile(this.coverPath(`${id}.png`), Buffer.from(bytes));
    book.coverVersion = Date.now();
    this._scheduleSave();
    return book;
  }

  getSettings() {
    return this.data.settings;
  }

  setSettings(patch) {
    this.data.settings = { ...this.data.settings, ...(patch || {}) };
    this._scheduleSave();
    return this.data.settings;
  }
}

module.exports = { Library };
