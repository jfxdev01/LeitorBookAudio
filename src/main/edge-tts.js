'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

const SYNTH_TIMEOUT_MS = 30000;

function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function signed(value, unit) {
  const n = Math.round(Number(value) || 0);
  return `${n >= 0 ? '+' : ''}${n}${unit}`;
}

/** Extrai as marcações de palavra (WordBoundary) do texto de metadados recebido. */
function parseWordBoundaries(raw) {
  const words = [];
  const re = /"Offset"\s*:\s*(\d+)\s*,\s*"Duration"\s*:\s*(\d+)\s*,\s*"text"\s*:\s*\{\s*"Text"\s*:\s*("(?:[^"\\]|\\.)*")/g;
  let m;
  while ((m = re.exec(raw))) {
    let text;
    try { text = JSON.parse(m[3]); } catch { text = m[3].slice(1, -1); }
    // Offset/Duration vêm em ticks de 100 ns; converte para milissegundos.
    words.push({ offset: Number(m[1]) / 10000, duration: Number(m[2]) / 10000, text });
  }
  words.sort((a, b) => a.offset - b.offset);
  return words;
}

/** Nome amigável a partir de "Microsoft Francisca Online (Natural) - Portuguese (Brazil)". */
function friendlyVoiceName(voice) {
  const fromFriendly = /Microsoft\s+(.+?)\s+Online/i.exec(voice.FriendlyName || '');
  if (fromFriendly) return fromFriendly[1];
  const short = (voice.ShortName || '').split('-').slice(2).join('-');
  return short.replace(/Neural$/, '') || voice.ShortName;
}

class EdgeTTSService {
  constructor(cacheDir) {
    this.voicesFile = path.join(cacheDir, 'edge-voices.json');
    this.voices = null;
    this.clients = new Map(); // voz -> { tts, chain }
  }

  async getVoices(force = false) {
    if (this.voices && !force) return this.voices;
    try {
      const tts = new MsEdgeTTS();
      const list = await tts.getVoices();
      try { tts.close(); } catch { /* ignora */ }
      this.voices = list
        .filter((v) => !v.Status || v.Status === 'GA' || v.Status === 'Preview')
        .map((v) => ({
          id: v.ShortName,
          name: friendlyVoiceName(v),
          locale: v.Locale,
          gender: v.Gender,
          multilingual: /Multilingual/i.test(v.ShortName)
        }));
      await fsp.writeFile(this.voicesFile, JSON.stringify(this.voices), 'utf8').catch(() => {});
      return this.voices;
    } catch (err) {
      // Sem internet: usa a última lista conhecida para não deixar o menu vazio.
      try {
        this.voices = JSON.parse(await fsp.readFile(this.voicesFile, 'utf8'));
        return this.voices;
      } catch {
        throw new Error(`Não foi possível obter as vozes neurais online (${err.message}).`);
      }
    }
  }

  async _client(voice) {
    let entry = this.clients.get(voice);
    if (!entry) {
      const tts = new MsEdgeTTS({ connectionTimeoutMs: 12000, synthesisTimeoutMs: SYNTH_TIMEOUT_MS });
      entry = { tts, ready: null, chain: Promise.resolve() };
      entry.ready = tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, { wordBoundaryEnabled: true });
      this.clients.set(voice, entry);
    }
    try {
      await entry.ready;
    } catch (err) {
      this._dispose(voice);
      throw err;
    }
    return entry;
  }

  _dispose(voice) {
    const entry = this.clients.get(voice);
    if (!entry) return;
    this.clients.delete(voice);
    try { entry.tts.close(); } catch { /* ignora */ }
  }

  _runOnce(entry, text, options) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const chunks = [];
      let meta = '';
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err); else resolve(value);
      };
      const timer = setTimeout(() => finish(new Error('Tempo esgotado ao sintetizar a voz.')), SYNTH_TIMEOUT_MS + 2000);
      let streams;
      try {
        streams = entry.tts.toStream(escapeXml(text), options);
      } catch (err) {
        finish(err);
        return;
      }
      const { audioStream, metadataStream } = streams;
      metadataStream?.on('data', (d) => { meta += d.toString('utf8'); });
      metadataStream?.on('error', () => {});
      audioStream.on('data', (d) => chunks.push(d));
      audioStream.on('error', (err) => finish(err));
      audioStream.on('end', () => {
        // Dá uma pequena folga para os últimos metadados chegarem.
        setImmediate(() => {
          const audio = Buffer.concat(chunks);
          if (!audio.length) {
            finish(new Error('A síntese retornou áudio vazio.'));
            return;
          }
          finish(null, { audio, words: parseWordBoundaries(meta) });
        });
      });
    });
  }

  /**
   * Sintetiza um trecho de texto.
   * @returns {Promise<{audio: Buffer, words: {offset:number, duration:number, text:string}[]}>}
   */
  async synthesize({ text, voice, pitch = 0, rate = 0, volume = 0 }) {
    if (!text || !text.trim()) return { audio: Buffer.alloc(0), words: [] };
    if (!voice) throw new Error('Nenhuma voz selecionada.');
    const options = { pitch: signed(pitch, '%'), rate: signed(rate, '%'), volume: signed(volume, '%') };

    const attempt = async () => {
      const entry = await this._client(voice);
      // Serializa as requisições por voz: o serviço é mais estável assim.
      const job = entry.chain.then(() => this._runOnce(entry, text, options));
      entry.chain = job.catch(() => {});
      return job;
    };

    try {
      return await attempt();
    } catch (err) {
      // Conexões ociosas podem cair; tenta de novo com um cliente novo.
      this._dispose(voice);
      try {
        return await attempt();
      } catch (err2) {
        this._dispose(voice);
        throw new Error(`Falha na voz neural online: ${err2.message || err.message}`);
      }
    }
  }

  closeAll() {
    for (const voice of [...this.clients.keys()]) this._dispose(voice);
  }
}

module.exports = { EdgeTTSService, parseWordBoundaries };
