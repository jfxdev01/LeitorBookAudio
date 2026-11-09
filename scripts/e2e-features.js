// Teste das funções extras: voz do Windows, busca, marcadores, menu de contexto,
// timer de sono, tema da página e geração de audiolivro (MP3).
// Uso: node scripts/e2e-features.js <pdf> <pastaDeSaida>
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { _electron: electron } = require('playwright-core');

const pdfPath = path.resolve(process.argv[2]);
const outDir = path.resolve(process.argv[3]);
fs.mkdirSync(outDir, { recursive: true });
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'leitorbook-feat-'));
const mp3Path = path.join(outDir, 'teste-audiolivro.mp3');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logs = [];
let failures = 0;
const check = (name, ok, extra = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'OK    ' : 'FALHOU'} ${name}${extra ? ` — ${extra}` : ''}`);
};

(async () => {
  const app = await electron.launch({ args: [path.join(__dirname, '..'), `--user-data=${userData}`], executablePath: require('electron') });
  const win = await app.firstWindow();
  win.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  win.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  await win.waitForFunction(() => window.__app && window.__app.store);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1300, 820));
  await win.evaluate(async (p) => {
    await window.__app.store.updateSettings({ engine: 'system', volume: 0, subtitles: true });
    window.__app.library.handleAdded(await window.api.library.addPaths([p]));
  }, pdfPath);
  await win.waitForFunction(() => window.__app.store.books[0] && !window.__app.store.books[0].needsProcessing, null, { timeout: 30000 });
  await win.click('.book-card .book-cover');
  await win.waitForSelector('.textLayer span', { timeout: 20000 });
  await sleep(600);

  // 1) Voz do Windows
  await win.click('#btn-play');
  await win.waitForFunction(() => document.querySelectorAll('.hl-rect.sentence').length > 0, null, { timeout: 15000 }).catch(() => {});
  await sleep(2500);
  const s1 = await win.evaluate(() => ({
    state: window.__app.reader.narrator.state,
    engine: window.__app.store.settings.engine,
    voice: window.__app.reader.currentVoice()?.name,
    words: document.querySelectorAll('.hl-rect.word').length
  }));
  check('narração com voz do Windows', s1.state === 'playing' && s1.engine === 'system', JSON.stringify(s1));
  await win.screenshot({ path: path.join(outDir, 'f1-voz-windows.png') });

  // 2) Menu de contexto: ouvir a partir de uma frase específica
  const pointOf = (text) => win.evaluate((t) => {
    const span = [...document.querySelectorAll('.textLayer span')].find((s) => s.textContent.includes(t));
    span.scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = span.getBoundingClientRect();
    return { x: r.left + 30, y: r.top + r.height / 2 };
  }, text);
  const target = await pointOf('proteger da tempestade');
  await win.mouse.click(target.x, target.y, { button: 'right' });
  await sleep(300);
  const menuItems = await win.evaluate(() => [...document.querySelectorAll('#context-menu button')].map((b) => b.textContent));
  check('menu de contexto', menuItems.includes('Ouvir a partir daqui'), menuItems.join(' | '));
  await win.screenshot({ path: path.join(outDir, 'f2-menu-contexto.png') });
  await win.click('#context-menu button:has-text("Ouvir a partir daqui")');
  await sleep(1500);
  const s2 = await win.evaluate(() => window.__app.reader.narrator.current?.sentence?.text);
  check('ouvir a partir daqui', /tempestade/.test(s2 || ''), s2);

  // 3) Clique numa frase durante a narração
  await win.evaluate(() => window.__app.store.updateSettings({ follow: false }));
  const target2 = await pointOf('O menino voltou');
  await win.mouse.click(target2.x - 10, target2.y);
  await sleep(1500);
  const s3 = await win.evaluate(() => window.__app.reader.narrator.current?.sentence?.text);
  check('clique numa frase pula a leitura', /menino voltou/.test(s3 || ''), s3);

  // 4) Pausar e continuar
  await win.keyboard.press('Space');
  await sleep(500);
  const paused = await win.evaluate(() => window.__app.reader.narrator.state);
  await win.keyboard.press('Space');
  await sleep(800);
  const resumed = await win.evaluate(() => window.__app.reader.narrator.state);
  check('pausar/continuar com Espaço', paused === 'paused' && (resumed === 'playing' || resumed === 'loading'), `${paused} -> ${resumed}`);

  // 5) Timer de sono
  await win.click('#btn-timer');
  await sleep(200);
  await win.click('#timer-menu button[data-timer="page"]');
  const chip = await win.evaluate(() => !document.querySelector('#chip-timer').hidden && document.querySelector('#chip-timer').textContent);
  check('timer de sono (fim da página)', !!chip, chip);
  await win.evaluate(() => window.__app.reader.narrator.stop());

  // 6) Busca
  await win.keyboard.press('Control+f');
  await win.fill('#search-input', 'menino');
  await win.waitForFunction(() => /resultado/.test(document.querySelector('#search-status').textContent), null, { timeout: 10000 });
  await sleep(400);
  const nres = await win.evaluate(() => document.querySelectorAll('.search-result').length);
  await win.click('.search-result >> nth=0');
  await sleep(500);
  const active = await win.evaluate(() => document.querySelectorAll('.hl-rect.search.active').length);
  check('busca no livro', nres >= 2 && active > 0, `${nres} resultados, destaque ativo: ${active}`);
  await win.screenshot({ path: path.join(outDir, 'f3-busca.png') });

  // 7) Marcador
  await win.click('#viewer-container');
  await win.keyboard.press('Control+b');
  await sleep(500);
  await win.click('.side-tabs button[data-tab="bookmarks"]');
  const bms = await win.evaluate(() => window.__app.store.books[0].bookmarks.length);
  check('marcador com Ctrl+B', bms === 1);
  await win.fill('.bookmark-item textarea', 'Gostei deste trecho!');
  await sleep(900);
  const note = await win.evaluate(() => window.__app.store.books[0].bookmarks[0]?.note);
  check('anotação no marcador', note === 'Gostei deste trecho!', note);
  await win.screenshot({ path: path.join(outDir, 'f4-marcadores.png') });

  // 8) Tema noturno da página
  await win.click('#btn-pdf-theme');
  await win.click('#btn-pdf-theme');
  await sleep(400);
  const night = await win.evaluate(() => document.querySelector('#viewer').classList.contains('pdf-night'));
  check('tema noturno', night);
  await win.screenshot({ path: path.join(outDir, 'f5-noturno.png') });
  await win.click('#btn-pdf-theme');

  // 9) Exportar MP3 (diálogo de salvar simulado)
  await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, mp3Path);
  await win.click('#btn-export');
  await win.waitForSelector('.modal button:has-text("Gerar MP3")', { timeout: 15000 });
  await win.screenshot({ path: path.join(outDir, 'f6-exportar.png') });
  await win.click('.modal button:has-text("Gerar MP3")');
  await win.waitForFunction(() => !document.querySelector('.modal'), null, { timeout: 90000 });
  await sleep(500);
  const size = fs.existsSync(mp3Path) ? fs.statSync(mp3Path).size : 0;
  check('audiolivro MP3 gerado', size > 10000, `${size} bytes`);

  // 10) Volta à biblioteca: "continuar de onde parou"
  await win.click('#btn-back');
  await sleep(800);
  const cont = await win.evaluate(() => {
    const b = window.__app.store.books[0];
    // Livro de 1 página aberto = concluído (não aparece em "continuar").
    return b.finished ? document.querySelector('#lib-continue').hidden && b.progress === 1 : !document.querySelector('#lib-continue').hidden;
  });
  check('progresso / cartão "continuar de onde parou"', cont);

  // 11) Modelo de texto: hifenização, abreviações e frases entre páginas (dados sintéticos)
  const model = await win.evaluate(async () => {
    const m = await import('./js/pdf-doc.js');
    const it = (str, y, eol = true) => ({ str, hasEOL: eol, transform: [12, 0, 0, 12, 50, y], width: str.length * 6, height: 12, fontName: 'f' });
    const p1 = m.buildPageText({ items: [it('This is an exam-', 700), it('ple of hyphen-', 686), it('ation. Dr. Smith arrived at the', 672, false)] });
    const p2 = m.buildPageText({ items: [it('station very late. Then he left.', 700, false)] });
    const pages = { 1: p1, 2: p2 };
    const s1 = m.segmentPage(p1, 'en');
    const spoken = s1.map((r) => m.buildSpokenText([{ page: 1, ...r }], (n) => pages[n]).text);
    const s2 = m.segmentPage(p2, 'en');
    const cross = m.buildSpokenText([{ page: 1, ...s1[s1.length - 1] }, { page: 2, ...s2[0] }], (n) => pages[n]).text;
    return { spoken, cross };
  });
  check('hifenização de fim de linha', model.spoken[0] === 'This is an example of hyphenation.', model.spoken[0]);
  check('abreviação "Dr." não quebra a frase', /^Dr\. Smith arrived at the$/.test(model.spoken[1] || ''), model.spoken[1]);
  check('frase que atravessa a página', model.cross === 'Dr. Smith arrived at the station very late.', model.cross);
  await win.screenshot({ path: path.join(outDir, 'f7-biblioteca.png') });

  const errors = logs.filter((l) => /\[(error|pageerror)\]/.test(l));
  console.log(`Console: ${logs.length} mensagens, ${errors.length} erros · ${failures} verificação(ões) com falha`);
  errors.slice(0, 10).forEach((l) => console.log(l));
  await app.close();
  fs.rmSync(userData, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error('FALHA:', err.message);
  console.error(logs.slice(-20).join('\n'));
  process.exit(1);
});
