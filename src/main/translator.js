'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_CACHE_ENTRIES = 30000;
const REQUEST_TIMEOUT_MS = 15000;

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Google Tradutor (endpoint público, sem chave). */
async function googleTranslate(text, from, to) {
  const params = new URLSearchParams({ client: 'gtx', sl: from || 'auto', tl: to, dt: 't', q: text });
  const url = `https://translate.googleapis.com/translate_a/single?${params}`;
  const res = await fetchWithTimeout(url, { method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`Google Tradutor respondeu ${res.status}`);
  const data = await res.json();
  const translated = (data?.[0] || []).map((part) => part?.[0] || '').join('');
  return { text: translated.trim(), detected: data?.[2] || null };
}

/** DeepL (requer chave de API gratuita ou paga). */
async function deeplTranslate(text, from, to, key) {
  if (!key) throw new Error('Informe a chave da API DeepL nas configurações.');
  const host = key.trim().endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
  const target = to.toUpperCase() === 'PT' ? 'PT-BR' : to.toUpperCase() === 'EN' ? 'EN-US' : to.toUpperCase();
  const body = { text: [text], target_lang: target };
  if (from && from !== 'auto') body.source_lang = from.split('-')[0].toUpperCase();
  const res = await fetchWithTimeout(`${host}/v2/translate`, {
    method: 'POST',
    headers: { Authorization: `DeepL-Auth-Key ${key.trim()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`DeepL respondeu ${res.status}`);
  const data = await res.json();
  const t = data?.translations?.[0];
  return { text: (t?.text || '').trim(), detected: t?.detected_source_language?.toLowerCase() || null };
}

/** LibreTranslate (servidor próprio ou público). */
async function libreTranslate(text, from, to, url, key) {
  if (!url) throw new Error('Informe o endereço do servidor LibreTranslate nas configurações.');
  const res = await fetchWithTimeout(`${url.replace(/\/+$/, '')}/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: text, source: (from || 'auto').split('-')[0], target: to.split('-')[0], format: 'text', api_key: key || undefined })
  });
  if (!res.ok) throw new Error(`LibreTranslate respondeu ${res.status}`);
  const data = await res.json();
  return { text: (data?.translatedText || '').trim(), detected: data?.detectedLanguage?.language || null };
}

class Translator {
  constructor(cacheDir, getSettings) {
    this.cacheFile = path.join(cacheDir, 'translation-cache.json');
    this.getSettings = getSettings;
    this.cache = new Map();
    this._saveTimer = null;
    try {
      const entries = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
      if (Array.isArray(entries)) this.cache = new Map(entries);
    } catch { /* cache vazio */ }
  }

  _key(provider, from, to, text) {
    return crypto.createHash('sha1').update(`${provider}|${from}|${to}|${text}`).digest('base64');
  }

  _remember(key, value) {
    this.cache.delete(key);
    this.cache.set(key, value);
    while (this.cache.size > MAX_CACHE_ENTRIES) {
      this.cache.delete(this.cache.keys().next().value);
    }
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.flush(), 3000);
  }

  flush() {
    clearTimeout(this._saveTimer);
    try {
      fs.writeFileSync(this.cacheFile, JSON.stringify([...this.cache.entries()]), 'utf8');
    } catch (err) {
      console.error('Falha ao salvar cache de tradução:', err);
    }
  }

  async translate({ text, from, to }) {
    const clean = String(text || '').trim();
    if (!clean) return { text: '', detected: null, cached: true };
    const settings = this.getSettings() || {};
    const provider = settings.translationProvider || 'google';
    const key = this._key(provider, from || 'auto', to, clean);
    const hit = this.cache.get(key);
    if (hit) {
      this._remember(key, hit);
      return { ...hit, cached: true };
    }

    let result;
    try {
      if (provider === 'deepl') result = await deeplTranslate(clean, from, to, settings.deeplKey);
      else if (provider === 'libre') result = await libreTranslate(clean, from, to, settings.libreUrl, settings.libreKey);
      else result = await googleTranslate(clean, from, to);
    } catch (err) {
      // Se o provedor configurado falhar, tenta o Google como reserva.
      if (provider !== 'google') {
        result = await googleTranslate(clean, from, to);
      } else {
        const msg = err.name === 'AbortError' ? 'tempo esgotado' : err.message;
        throw new Error(`Não foi possível traduzir (${msg}). Verifique a conexão com a internet.`);
      }
    }
    if (!result.text) throw new Error('O serviço de tradução retornou um texto vazio.');
    this._remember(key, { text: result.text, detected: result.detected });
    return { ...result, cached: false };
  }

  async detect(text) {
    const sample = String(text || '').slice(0, 600);
    if (!sample.trim()) return null;
    try {
      const { detected } = await googleTranslate(sample, 'auto', 'en');
      return detected;
    } catch {
      return null;
    }
  }
}

module.exports = { Translator };
