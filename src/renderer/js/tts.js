// Motores de voz: vozes do Windows (Web Speech API) e vozes neurais online (Microsoft Edge).
// Interface comum: speak(text, opts, callbacks) -> controla uma fala; pause/resume/cancel.

import { baseLang } from './lang.js';

/** Vozes instaladas no sistema (SAPI), via speechSynthesis do Chromium. */
export class SystemEngine {
  constructor() {
    this.id = 'system';
    this.current = null;
    this.keepAlive = []; // evita que o GC descarte a fala antes dos eventos
    this.paused = false;
  }

  voices() {
    return new Promise((resolve) => {
      const map = () => speechSynthesis.getVoices().map((v) => ({
        id: v.voiceURI,
        name: v.name.replace(/^Microsoft\s+/i, '').replace(/\s+Desktop\b/i, '').replace(/\s+-\s+.*$/, ''),
        locale: v.lang,
        gender: /zira|maria|helena|hazel|susan|heera|haruka|huihui|hanhan|tracy|irina|hortense|julie|katja|hedda|elsa|paulina|sabina|heami|zuzana|helia|lucia/i.test(v.name) ? 'Female' : 'Male',
        local: v.localService,
        native: v
      }));
      const list = map();
      if (list.length) return resolve(list);
      const done = () => resolve(map());
      speechSynthesis.addEventListener('voiceschanged', done, { once: true });
      setTimeout(done, 1500);
    });
  }

  async speak(text, opts, cb) {
    this.cancel();
    const voices = await this.voices();
    const voice = voices.find((v) => v.id === opts.voice) || voices.find((v) => baseLang(v.locale) === baseLang(opts.lang));
    const u = new SpeechSynthesisUtterance(text);
    if (voice) {
      u.voice = voice.native;
      u.lang = voice.locale;
    } else if (opts.lang) {
      u.lang = opts.lang;
    }
    u.rate = Math.max(0.1, Math.min(10, opts.rate || 1));
    u.pitch = Math.max(0, Math.min(2, 1 + (opts.pitch || 0) / 100));
    u.volume = Math.max(0, Math.min(1, opts.volume ?? 1));
    const token = Symbol('fala');
    this.current = { token, utterance: u, offset: 0, text, opts, cb, lastBoundary: 0 };
    const isCurrent = () => this.current && this.current.token === token;

    u.onstart = () => { if (isCurrent()) cb.onStart?.(); };
    u.onboundary = (e) => {
      if (!isCurrent() || (e.name && e.name !== 'word')) return;
      const off = this.current.offset;
      const idx = off + e.charIndex;
      let len = e.charLength;
      if (!len) {
        const m = /^[\p{L}\p{N}'’-]+/u.exec(text.slice(idx));
        len = m ? m[0].length : 1;
      }
      this.current.lastBoundary = idx;
      cb.onBoundary?.(idx, len);
    };
    u.onend = () => {
      if (!isCurrent() || this.paused) return;
      this.current = null;
      cb.onEnd?.();
    };
    u.onerror = (e) => {
      if (!isCurrent() || this.paused) return;
      if (e.error === 'interrupted' || e.error === 'canceled') return;
      this.current = null;
      cb.onError?.(new Error(`Erro na voz do sistema: ${e.error}`));
    };
    this.keepAlive.push(u);
    if (this.keepAlive.length > 5) this.keepAlive.shift();
    this.paused = false;
    speechSynthesis.speak(u);
  }

  /** Pausa cancelando a fala e retomando depois a partir da última palavra (mais confiável no Windows). */
  pause() {
    if (!this.current) return;
    this.paused = true;
    speechSynthesis.cancel();
  }

  resume() {
    if (!this.current || !this.paused) return;
    const { text, opts, cb, lastBoundary, token } = this.current;
    const offset = lastBoundary;
    const rest = text.slice(offset);
    this.paused = false;
    const u = new SpeechSynthesisUtterance(rest);
    const old = this.current.utterance;
    u.voice = old.voice;
    u.lang = old.lang;
    u.rate = opts.rate || 1;
    u.pitch = old.pitch;
    u.volume = old.volume;
    this.current.utterance = u;
    this.current.offset = offset;
    const isCurrent = () => this.current && this.current.token === token;
    u.onboundary = (e) => {
      if (!isCurrent() || (e.name && e.name !== 'word')) return;
      const idx = offset + e.charIndex;
      let len = e.charLength;
      if (!len) {
        const m = /^[\p{L}\p{N}'’-]+/u.exec(text.slice(idx));
        len = m ? m[0].length : 1;
      }
      this.current.lastBoundary = idx;
      cb.onBoundary?.(idx, len);
    };
    u.onend = () => {
      if (!isCurrent() || this.paused) return;
      this.current = null;
      cb.onEnd?.();
    };
    u.onerror = (e) => {
      if (!isCurrent() || this.paused) return;
      if (e.error === 'interrupted' || e.error === 'canceled') return;
      this.current = null;
      cb.onError?.(new Error(`Erro na voz do sistema: ${e.error}`));
    };
    this.keepAlive.push(u);
    speechSynthesis.speak(u);
  }

  setRate(rate) {
    // Aplica na próxima frase (a Web Speech API não permite mudar durante a fala).
    if (this.current) this.current.opts = { ...this.current.opts, rate };
  }

  setVolume() { /* aplicado na próxima frase */ }

  cancel() {
    this.current = null;
    this.paused = false;
    speechSynthesis.cancel();
  }

  prefetch() { /* nada a fazer */ }
}

/** Vozes neurais online (Microsoft Edge Read Aloud), sintetizadas no processo principal. */
export class EdgeEngine {
  constructor() {
    this.id = 'edge';
    this.audio = new Audio();
    this.audio.preservesPitch = true;
    this.cache = new Map(); // chave -> Promise<{url, words}>
    this.current = null;
    this._voices = null;
    this._raf = 0;
  }

  async voices(force = false) {
    if (this._voices && !force) return this._voices;
    this._voices = await window.api.tts.voices(force);
    return this._voices;
  }

  _key(text, opts) {
    return `${opts.voice}|${opts.pitch || 0}|${text}`;
  }

  synth(text, opts) {
    const key = this._key(text, opts);
    let p = this.cache.get(key);
    if (!p) {
      p = window.api.tts.synthesize({ text, voice: opts.voice, pitch: opts.pitch || 0 })
        .then(({ audio, words }) => {
          const blob = new Blob([audio], { type: 'audio/mpeg' });
          return { url: URL.createObjectURL(blob), words: mapWords(text, words), bytes: audio };
        });
      p.catch(() => this.cache.delete(key));
      this.cache.set(key, p);
      // Limita o cache em memória.
      if (this.cache.size > 40) {
        const oldestKey = this.cache.keys().next().value;
        const oldest = this.cache.get(oldestKey);
        this.cache.delete(oldestKey);
        oldest.then((r) => URL.revokeObjectURL(r.url)).catch(() => {});
      }
    }
    return p;
  }

  prefetch(text, opts) {
    if (text && opts.voice) this.synth(text, opts).catch(() => {});
  }

  async speak(text, opts, cb) {
    this.cancel();
    const token = Symbol('fala');
    this.current = { token, cb, opts };
    const isCurrent = () => this.current && this.current.token === token;
    let data;
    try {
      data = await this.synth(text, opts);
    } catch (err) {
      if (isCurrent()) {
        this.current = null;
        cb.onError?.(err);
      }
      return;
    }
    if (!isCurrent()) return;
    const audio = this.audio;
    audio.src = data.url;
    audio.playbackRate = Math.max(0.25, Math.min(4, opts.rate || 1));
    audio.volume = Math.max(0, Math.min(1, opts.volume ?? 1));
    let lastWord = -1;
    const tick = () => {
      if (!isCurrent()) return;
      const t = audio.currentTime * 1000;
      let idx = -1;
      for (let i = 0; i < data.words.length; i++) {
        if (data.words[i].offset <= t + 30) idx = i; else break;
      }
      if (idx !== lastWord && idx >= 0) {
        lastWord = idx;
        const w = data.words[idx];
        if (w.charIndex >= 0) cb.onBoundary?.(w.charIndex, w.charLength);
      }
      this._raf = requestAnimationFrame(tick);
    };
    audio.onended = () => {
      if (!isCurrent()) return;
      cancelAnimationFrame(this._raf);
      this.current = null;
      cb.onEnd?.();
    };
    audio.onerror = () => {
      if (!isCurrent()) return;
      cancelAnimationFrame(this._raf);
      this.current = null;
      cb.onError?.(new Error('Não foi possível reproduzir o áudio.'));
    };
    try {
      await audio.play();
    } catch (err) {
      if (isCurrent()) {
        this.current = null;
        cb.onError?.(err);
      }
      return;
    }
    if (!isCurrent()) return;
    cb.onStart?.();
    cancelAnimationFrame(this._raf);
    this._raf = requestAnimationFrame(tick);
  }

  pause() {
    if (this.current) this.audio.pause();
  }

  resume() {
    if (this.current) this.audio.play().catch(() => {});
  }

  setRate(rate) {
    this.audio.playbackRate = Math.max(0.25, Math.min(4, rate));
    if (this.current) this.current.opts = { ...this.current.opts, rate };
  }

  setVolume(volume) {
    this.audio.volume = Math.max(0, Math.min(1, volume));
  }

  cancel() {
    this.current = null;
    cancelAnimationFrame(this._raf);
    try {
      this.audio.pause();
    } catch { /* ignora */ }
  }
}

/** Associa cada palavra retornada pelo serviço à sua posição no texto falado. */
function mapWords(text, words) {
  let cursor = 0;
  const lower = text.toLowerCase();
  return words.map((w) => {
    const token = String(w.text || '');
    let idx = token ? lower.indexOf(token.toLowerCase(), cursor) : -1;
    if (idx < 0 || idx - cursor > 60) idx = -1;
    if (idx >= 0) cursor = idx + token.length;
    return { offset: w.offset, duration: w.duration, charIndex: idx, charLength: token.length };
  });
}
