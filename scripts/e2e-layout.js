// Teste de layout: captura biblioteca e leitor em larguras diferentes de janela.
// Uso: node scripts/e2e-layout.js <pdf1> [pdf2] <pastaDeSaida>
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { _electron: electron } = require('playwright-core');

const args = process.argv.slice(2);
const outDir = path.resolve(args.pop());
const pdfs = args.map((p) => path.resolve(p));
fs.mkdirSync(outDir, { recursive: true });
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'leitorbook-layout-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logs = [];

(async () => {
  const app = await electron.launch({ args: [path.join(__dirname, '..'), `--user-data=${userData}`], executablePath: require('electron') });
  const win = await app.firstWindow();
  win.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  win.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  await win.waitForFunction(() => window.__app && window.__app.store);
  const resize = async (w, hgt) => {
    await app.evaluate(({ BrowserWindow }, [w2, h2]) => {
      const bw = BrowserWindow.getAllWindows()[0];
      bw.unmaximize();
      bw.setContentSize(w2, h2);
    }, [w, hgt]);
    await sleep(700);
    return win.evaluate(() => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio }));
  };
  await win.evaluate(async (list) => {
    const res = await window.api.library.addPaths(list);
    window.__app.library.handleAdded(res);
  }, pdfs);
  await win.waitForFunction((n) => window.__app.store.books.length === n && window.__app.store.books.every((b) => !b.needsProcessing), pdfs.length, { timeout: 60000 });
  await sleep(4500);

  for (const [w, hgt, tag] of [[960, 640, 'estreita'], [1900, 1000, 'larga']]) {
    const dims = await resize(w, hgt);
    console.log(tag, JSON.stringify(dims));
    await win.screenshot({ path: path.join(outDir, `lib-${tag}.png`) });
  }

  // Leitor em janela estreita com barra lateral aberta
  await resize(960, 640);
  await win.click('.book-card .book-cover');
  await win.waitForSelector('.textLayer span', { timeout: 20000 });
  await sleep(800);
  await win.evaluate(() => window.__app.reader.toggleSidebar(true));
  await sleep(500);
  await win.screenshot({ path: path.join(outDir, 'reader-estreita.png') });
  const overflow = await win.evaluate(() => {
    const els = ['.reader-top', '.player', '.lib-header'].map((s) => document.querySelector(s));
    return els.map((el) => el && { sel: el.className, scrollW: el.scrollWidth, clientW: el.clientWidth });
  });
  console.log('overflow', JSON.stringify(overflow));
  await resize(1900, 1000);
  await sleep(600);
  await win.screenshot({ path: path.join(outDir, 'reader-larga.png') });

  fs.writeFileSync(path.join(outDir, 'console.log'), logs.join('\n'));
  console.log(`Console: ${logs.length} mensagens, ${logs.filter((l) => /\[(error|pageerror)\]/.test(l)).length} erros`);
  logs.filter((l) => /\[(error|pageerror)\]/.test(l)).slice(0, 10).forEach((l) => console.log(l));
  await app.close();
  fs.rmSync(userData, { recursive: true, force: true });
})().catch((err) => {
  console.error('FALHA:', err.message);
  console.error(logs.slice(-20).join('\n'));
  process.exit(1);
});
