// Gera PDFs de exemplo (inglês e português) para testar a leitura e a narração.
const fs = require('node:fs');
const path = require('node:path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const EN = [
  { h: 'Chapter One: The Lighthouse' },
  'The old lighthouse stood at the edge of the world, or so it seemed to the children who grew up in the village below. Every evening, Mr. Thompson climbed the one hundred and twelve steps to light the great lamp. He was a quiet man, with hands like weathered rope and eyes the color of the winter sea.',
  'Nobody remembered when he had arrived. Some said he came on a fishing boat during the great storm of 1952; others swore he had always been there, as permanent as the rocks themselves. The truth, as usual, was somewhere in between.',
  'One autumn morning, a girl named Clara knocked on the heavy wooden door. She carried a notebook full of questions and a pencil worn down to a stub. "I want to know how the light works," she said. Mr. Thompson looked at her for a long moment, then stepped aside and let her in.',
  { h: 'Chapter Two: The Questions' },
  'Clara visited every day after school. She learned about lenses and mirrors, about the clockwork that turned the beam, and about the ships that depended on it. She learned that light could travel farther than sound, and that silence could say more than words.',
  'In return, she told him about the village: who had married whom, which boats had come back with full nets, and what the teacher had said about the planets. He listened carefully, as if every detail mattered. Perhaps, to him, it did.',
  'Years later, when Clara became the first woman to keep the lighthouse, she would remember those afternoons as the beginning of everything. The lamp still turns tonight, sweeping its patient circle across the dark water, guiding travelers home.'
];
const PT = [
  { h: 'Capítulo 1 — A Biblioteca' },
  'A biblioteca da cidade ficava numa casa antiga, de janelas altas e portas pesadas. Dona Helena cuidava dos livros havia mais de trinta anos e conhecia cada estante como quem conhece a palma da mão.',
  'Numa tarde de chuva, um menino entrou correndo para se proteger da tempestade. Ele nunca tinha lido um livro inteiro. Dona Helena sorriu, escolheu uma história de piratas e disse: "Comece por aqui. Se não gostar, devolva amanhã."',
  'O menino voltou no dia seguinte, e no outro, e no outro. Em poucos meses, já tinha lido todas as aventuras da estante dos fundos. Quando cresceu, tornou-se escritor e dedicou seu primeiro romance à mulher que lhe apresentou o mundo das palavras.'
];

async function build(paragraphs, title, author, outFile, repeat) {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setAuthor(author);
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  const bold = await doc.embedFont(StandardFonts.TimesRomanBold);
  const W = 420, H = 600, M = 50, size = 13, lead = 18;
  let page = null, y = 0, pageNo = 0;
  const newPage = () => {
    page = doc.addPage([W, H]);
    pageNo++;
    y = H - M;
    page.drawText(String(pageNo), { x: W / 2 - 4, y: 25, size: 10, font, color: rgb(0.4, 0.4, 0.4) });
  };
  newPage();
  const all = [];
  for (let r = 0; r < repeat; r++) all.push(...paragraphs);
  for (const p of all) {
    if (typeof p === 'object') {
      if (y < M + 80) newPage();
      y -= 10;
      page.drawText(p.h, { x: M, y, size: 18, font: bold });
      y -= 34;
      continue;
    }
    const words = p.split(' ');
    let line = '';
    const lines = [];
    for (const w of words) {
      const test = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(test, size) > W - 2 * M) { lines.push(line); line = w; } else line = test;
    }
    if (line) lines.push(line);
    for (const l of lines) {
      if (y < M + 10) newPage();
      page.drawText(l, { x: M, y, size, font });
      y -= lead;
    }
    y -= 8;
  }
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, await doc.save());
  console.log('PDF gerado:', outFile, `(${pageNo} páginas)`);
}

const outDir = process.argv[2] || path.join(__dirname, '..', 'samples');
(async () => {
  await build(EN, 'The Lighthouse Keeper', 'A. Example', path.join(outDir, 'the-lighthouse-keeper.pdf'), 4);
  await build(PT, 'A Biblioteca', 'Autora Exemplo', path.join(outDir, 'a-biblioteca.pdf'), 1);
})();
