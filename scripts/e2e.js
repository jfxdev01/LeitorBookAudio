// Teste de ponta a ponta: abre o app, cadastra um PDF, abre o leitor, narra e traduz.
// Uso: node scripts/e2e.js <pdf> <pastaDeSaida>
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { _electron: electron } = require('playwright-core');

const pdfPath = path.resolve(process.argv[2] || path.join(__dirname, '..', 'samples', 'the-lighthouse-keeper.pdf'));
const outDir = path.resolve(process.argv[3] || path.join(os.tmpdir(), 'leitorbook-e2e'));
const scenario = process.argv[4] || 'full';
fs.mkdirSync(outDir, { recursive: true });
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'leitorbook-data-'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logs = [];

(async () => {
  const app = await electron.launch({
    args: [path.join(__dirname, '..'), `--user-data=${userData}`],
    executablePath: require('electron')
  });
  const win = await app.firstWindow();
  win.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  win.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack}`));
  await win.waitForFunction(() => window.__app && window.__app.store);
  await win.screenshot({ path: path.join(outDir, '01-biblioteca-vazia.png') });

  // Cadastra o livro
  await win.evaluate(async (p) => {
    const res = await window.api.library.addPaths([p]);
    window.__app.library.handleAdded(res);
  }, pdfPath);
  await win.waitForFunction(() => window.__app.store.books.length && !window.__app.store.books[0].needsProcessing, null, { timeout: 30000 });
  await sleep(600);
  const book = await win.evaluate(() => window.__app.store.books[0]);
  console.log('Livro:', JSON.stringify({ title: book.title, author: book.author, pages: book.pageCount, lang: book.language, cover: book.coverVersion }));
  await win.screenshot({ path: path.join(outDir, '02-biblioteca.png') });

  // Abre o leitor
  await win.click('.book-card .book-cover');
  await win.waitForSelector('.page canvas', { timeout: 20000 });
  await win.waitForSelector('.textLayer span', { timeout: 20000 });
  await sleep(800);
  await win.screenshot({ path: path.join(outDir, '03-leitor.png') });

  // Frases da página 1
  const sentences = await win.evaluate(async () => {
    const r = window.__app.reader;
    const out = [];
    for (let p = 1; p <= Math.min(3, r.bookText.numPages); p++) {
      const list = await r.bookText.getSentences(p);
      out.push(...list.map((s) => `${s.key} [${s.segments.map((g) => g.page).join('+')}] ${s.text}`));
    }
    return out;
  });
  console.log('Frases:\n' + sentences.join('\n'));

  // Narração com voz do sistema (offline)
  const engine = scenario === 'edge' ? 'edge' : 'system';
  await win.evaluate(async (eng) => {
    await window.__app.store.updateSettings({ engine: eng, subtitles: true, audioLang: 'same', volume: 0.0 });
    await window.__app.reader.setAudioLang('same');
  }, engine);
  await win.click('#btn-play');
  await win.waitForFunction(() => document.querySelectorAll('.hl-rect.sentence').length > 0, null, { timeout: 20000 }).catch(async () => {
    console.log('Sem destaque após 20s:', JSON.stringify(await win.evaluate(() => ({
      state: window.__app.reader.narrator.state, pos: window.__app.reader.narrator.pos,
      cfg: window.__app.reader.narrationConfig(), toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent),
      hl: window.__app.reader.viewer.highlights.sentence
    }))));
  });
  await sleep(2500);
  const state1 = await win.evaluate(() => ({
    state: window.__app.reader.narrator.state,
    pos: window.__app.reader.narrator.pos,
    sentenceRects: document.querySelectorAll('.hl-rect.sentence').length,
    wordRects: document.querySelectorAll('.hl-rect.word').length,
    status: document.querySelector('#player-status').textContent,
    subtitle: document.querySelector('#sub-main').textContent
  }));
  console.log('Narração:', JSON.stringify(state1));
  await win.screenshot({ path: path.join(outDir, '04-narrando.png') });

  await win.click('#btn-next-sentence');
  await sleep(1500);
  await win.screenshot({ path: path.join(outDir, '05-proxima-frase.png') });

  // Tradução simultânea para português com voz neural
  if (scenario !== 'offline') {
    await win.evaluate(async () => {
      await window.__app.store.updateSettings({ engine: 'edge' });
      await window.__app.reader.setAudioLang('pt', true);
    });
    await win.waitForFunction(() => {
      const t = document.querySelector('#sub-main').textContent;
      return t && !/Traduzindo/.test(t) && window.__app.reader.narrator.state === 'playing';
    }, null, { timeout: 30000 }).catch(() => {});
    await sleep(2500);
    const state2 = await win.evaluate(() => ({
      state: window.__app.reader.narrator.state,
      orig: document.querySelector('#sub-orig').textContent,
      main: document.querySelector('#sub-main').textContent,
      chip: document.querySelector('#chip-translation').textContent
    }));
    console.log('Tradução:', JSON.stringify(state2));
    await win.screenshot({ path: path.join(outDir, '06-traducao.png') });
    await win.click('#btn-voice-settings');
    await sleep(800);
    await win.screenshot({ path: path.join(outDir, '07-painel-voz.png') });
  }

  await win.evaluate(() => window.__app.reader.narrator.stop());
  await sleep(300);
  fs.writeFileSync(path.join(outDir, 'console.log'), logs.join('\n'));
  const errors = logs.filter((l) => /\[(error|pageerror)\]/.test(l));
  console.log(`Console: ${logs.length} mensagens, ${errors.length} erros`);
  errors.slice(0, 15).forEach((e) => console.log(e));
  await app.close();
  fs.rmSync(userData, { recursive: true, force: true });
})().catch(async (err) => {
  console.error('FALHA:', err.message);
  console.error(logs.slice(-30).join('\n'));
  process.exit(1);
});
