// Gera build/icon.png (512x512) a partir de um SVG, usando o próprio Electron.
// Uso: npx electron scripts/make-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#2f8f86"/>
      <stop offset="1" stop-color="#164c47"/>
    </linearGradient>
  </defs>
  <rect x="16" y="16" width="480" height="480" rx="110" fill="url(#g)"/>
  <path d="M138 286v-46a118 118 0 0 1 236 0v46" fill="none" stroke="#ffffff" stroke-width="30" stroke-linecap="round"/>
  <rect x="104" y="252" width="64" height="104" rx="26" fill="#ffc94d"/>
  <rect x="344" y="252" width="64" height="104" rx="26" fill="#ffc94d"/>
  <path d="M256 318C232 302 206 296 182 298V398C206 396 232 402 256 418C280 402 306 396 330 398V298C306 296 280 302 256 318Z" fill="#ffffff"/>
  <path d="M256 320V414" stroke="#164c47" stroke-width="7" stroke-linecap="round"/>
  <path d="M198 324h40M198 344h40M198 364h32M274 324h40M274 344h40M274 364h32" stroke="#9cc9c3" stroke-width="7" stroke-linecap="round"/>
</svg>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 512, height: 512, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } });
  win.webContents.setZoomFactor(1);
  const html = `<html><body style="margin:0;background:transparent">${SVG}</body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((r) => setTimeout(r, 400));
  const image = (await win.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 })).resize({ width: 512, height: 512 });
  const out = path.join(__dirname, '..', 'build', 'icon.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, image.toPNG());
  fs.writeFileSync(path.join(__dirname, '..', 'build', 'icon.svg'), SVG);
  console.log('Ícone gerado em', out);
  app.quit();
});
