// Narrador: percorre as frases do livro, traduz quando necessário,
// fala com o motor escolhido e emite eventos para o destaque visual.

const PREFETCH_TRANSLATIONS = 4;
const PREFETCH_AUDIO = 2;

export class Narrator extends EventTarget {
  /**
   * @param {object} deps
   * @param {import('./pdf-doc.js').BookText} deps.bookText
   * @param {{system: any, edge: any}} deps.engines
   * @param {() => object} deps.getConfig  — { engine, voice, voiceLocale, rate, pitch, volume, bookLang, translateTo }
   */
  constructor({ bookText, engines, getConfig }) {
    super();
    this.bookText = bookText;
    this.engines = engines;
    this.getConfig = getConfig;
    this.state = 'idle'; // idle | loading | playing | paused
    this.pos = null;
    this.current = null;
    this.gen = 0;
    this.activeEngine = null;
    this.translations = new Map();
    this.stopAfterCurrent = false;
    this.stopAtPageEnd = null;
    this.stopBeforePage = null;
  }

  _emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  _setState(state) {
    if (this.state === state) return;
    this.state = state;
    this._emit('state', { state });
  }

  get isActive() {
    return this.state === 'playing' || this.state === 'loading';
  }

  translate(text, cfg) {
    const key = `${cfg.bookLang || 'auto'}>${cfg.translateTo}|${text}`;
    let p = this.translations.get(key);
    if (!p) {
      p = window.api.translate.text({ text, from: cfg.bookLang || 'auto', to: cfg.translateTo }).then((r) => r.text);
      p.catch(() => this.translations.delete(key));
      this.translations.set(key, p);
      if (this.translations.size > 400) this.translations.delete(this.translations.keys().next().value);
    }
    return p;
  }

  async play(pos = null) {
    const gen = ++this.gen;
    this.activeEngine?.cancel();
    if (pos) this.pos = pos;
    if (!this.pos) return;
    this._setState('loading');
    await this._speakCurrent(gen);
  }

  async _speakCurrent(gen) {
    let sentence;
    try {
      sentence = await this.bookText.sentenceAt(this.pos);
    } catch (err) {
      sentence = null;
      console.error(err);
    }
    if (gen !== this.gen) return;
    if (!sentence) {
      this._finish();
      return;
    }
    const cfg = this.getConfig();
    const translating = !!cfg.translateTo;
    this.current = { sentence, spoken: null, translating };
    this._emit('sentence', { sentence, translating });

    let spoken = sentence.text;
    if (translating) {
      try {
        spoken = await this.translate(sentence.text, cfg);
      } catch (err) {
        if (gen !== this.gen) return;
        this._setState('paused');
        this._emit('error', { error: err, kind: 'translate' });
        return;
      }
      if (gen !== this.gen) return;
    }
    this.current.spoken = spoken;
    this._emit('spoken', { sentence, spoken, translating });
    this._prefetch(cfg, gen);

    const engine = this.engines[cfg.engine] || this.engines.system;
    this.activeEngine = engine;
    engine.speak(spoken, {
      voice: cfg.voice,
      lang: cfg.voiceLocale,
      rate: cfg.rate,
      pitch: cfg.pitch,
      volume: cfg.volume
    }, {
      onStart: () => {
        if (gen === this.gen && this.state !== 'paused') this._setState('playing');
      },
      onBoundary: (start, length) => {
        if (gen === this.gen) this._emit('word', { sentence, spoken, start, end: start + length, translating });
      },
      onEnd: () => {
        if (gen === this.gen) this._advance(gen);
      },
      onError: (error) => {
        if (gen !== this.gen) return;
        this._setState('paused');
        this._emit('error', { error, kind: 'tts', engine: engine.id });
      }
    });
  }

  async _advance(gen) {
    const finished = this.current?.sentence;
    this._emit('sentenceend', { sentence: finished });
    let next = null;
    try {
      next = await this.bookText.next(this.pos);
    } catch (err) {
      console.error(err);
    }
    if (gen !== this.gen) return;
    if (!next) {
      this._finish();
      return;
    }
    const pageEndStop = this.stopAtPageEnd !== null && next.page > this.stopAtPageEnd;
    const chapterStop = this.stopBeforePage !== null && next.page >= this.stopBeforePage;
    this.pos = next;
    if (this.stopAfterCurrent || pageEndStop || chapterStop) {
      this.stopAfterCurrent = false;
      this.stopAtPageEnd = null;
      this.stopBeforePage = null;
      this.gen++;
      this.activeEngine?.cancel();
      this._setState('paused');
      this._emit('timerstop', {});
      const sentence = await this.bookText.sentenceAt(next);
      this.current = { sentence, spoken: null };
      this._emit('sentence', { sentence, translating: false, preview: true });
      return;
    }
    await this._speakCurrent(gen);
  }

  async _prefetch(cfg, gen) {
    let pos = this.pos;
    for (let i = 0; i < PREFETCH_TRANSLATIONS; i++) {
      pos = await this.bookText.next(pos).catch(() => null);
      if (!pos || gen !== this.gen) return;
      const s = await this.bookText.sentenceAt(pos);
      if (!s) return;
      let spokenPromise = Promise.resolve(s.text);
      if (cfg.translateTo) spokenPromise = this.translate(s.text, cfg);
      if (i < PREFETCH_AUDIO && cfg.engine === 'edge') {
        spokenPromise.then((txt) => {
          if (gen === this.gen) this.engines.edge.prefetch(txt, { voice: cfg.voice, pitch: cfg.pitch });
        }).catch(() => {});
      }
      if (cfg.translateTo) await spokenPromise.catch(() => {});
    }
  }

  _finish() {
    this.activeEngine?.cancel();
    this._setState('idle');
    this._emit('finished', {});
  }

  pause() {
    if (this.state === 'playing') {
      this.activeEngine?.pause();
      this._setState('paused');
    } else if (this.state === 'loading') {
      this.gen++;
      this.activeEngine?.cancel();
      this._setState('paused');
    }
  }

  resume() {
    if (this.state !== 'paused') return;
    const engine = this.activeEngine;
    if (engine && engine.current && this.current?.spoken) {
      engine.resume();
      this._setState('playing');
    } else {
      this.play(this.pos);
    }
  }

  toggle() {
    if (this.state === 'playing' || this.state === 'loading') this.pause();
    else if (this.state === 'paused') this.resume();
    else this.play(this.pos);
  }

  stop() {
    this.gen++;
    this.activeEngine?.cancel();
    this.stopAfterCurrent = false;
    this.stopAtPageEnd = null;
    this.stopBeforePage = null;
    this._setState('idle');
    this._emit('stopped', {});
  }

  async next() {
    if (!this.pos) return;
    const pos = await this.bookText.next(this.pos);
    if (pos) this.play(pos);
  }

  async prev() {
    if (!this.pos) return;
    const pos = await this.bookText.prev(this.pos);
    if (pos) this.play(pos);
  }

  /** Recomeça a frase atual (após trocar voz, idioma ou motor). */
  restart() {
    if (this.state === 'playing' || this.state === 'loading') this.play(this.pos);
    else if (this.state === 'paused') {
      this.gen++;
      this.activeEngine?.cancel();
      this.current = this.current ? { ...this.current, spoken: null } : null;
    }
  }

  setRate(rate) {
    this.activeEngine?.setRate(rate);
  }

  setVolume(volume) {
    this.activeEngine?.setVolume(volume);
  }

  destroy() {
    this.stop();
  }
}
