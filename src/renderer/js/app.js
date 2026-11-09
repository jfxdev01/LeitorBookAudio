// Ponto de entrada do renderer: carrega o estado, alterna telas e trata ações globais.

import { store } from './store.js';
import { $, h, hydrateIcons, toast, openModal } from './ui.js';
import { LibraryView } from './library-view.js';
import { ReaderView, engines } from './reader-view.js';

const libraryRoot = $('#view-library');
const readerRoot = $('#view-reader');

function applyTheme() {
  const pref = store.settings.theme;
  const dark = pref === 'dark' || (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

function showLibrary() {
  readerRoot.hidden = true;
  libraryRoot.hidden = false;
  library.render();
}

async function openBook(id, opts = {}) {
  const book = store.getBook(id);
  if (!book) return;
  if (book.needsProcessing) {
    toast('Preparando o livro… ele abre em instantes.', { duration: 2000 });
  }
  libraryRoot.hidden = true;
  readerRoot.hidden = false;
  await reader.open(id, opts);
}

const library = new LibraryView(libraryRoot, { onOpen: openBook });
const reader = new ReaderView(readerRoot, { onClose: showLibrary });

// ---------- Configurações ----------
function openSettings() {
  const s = store.settings;
  const theme = h('select', {},
    h('option', { value: 'system', text: 'Igual ao Windows' }),
    h('option', { value: 'light', text: 'Claro' }),
    h('option', { value: 'dark', text: 'Escuro' }));
  theme.value = s.theme;
  const provider = h('select', {},
    h('option', { value: 'google', text: 'Google Tradutor (gratuito, sem cadastro)' }),
    h('option', { value: 'deepl', text: 'DeepL (requer chave de API)' }),
    h('option', { value: 'libre', text: 'LibreTranslate (servidor próprio)' }));
  provider.value = s.translationProvider;
  const deeplKey = h('input', { type: 'password', value: s.deeplKey || '', placeholder: 'Chave da API DeepL (termina em :fx no plano gratuito)' });
  const libreUrl = h('input', { type: 'url', value: s.libreUrl || '', placeholder: 'https://seu-servidor-libretranslate' });
  const libreKey = h('input', { type: 'password', value: s.libreKey || '', placeholder: 'Chave (opcional)' });
  const deeplBox = h('label.field', {}, h('span.field-label', { text: 'Chave DeepL' }), deeplKey);
  const libreBox = h('div.field-row', {},
    h('label.field', {}, h('span.field-label', { text: 'Endereço do LibreTranslate' }), libreUrl),
    h('label.field', {}, h('span.field-label', { text: 'Chave' }), libreKey));
  const syncProvider = () => {
    deeplBox.hidden = provider.value !== 'deepl';
    libreBox.hidden = provider.value !== 'libre';
  };
  provider.addEventListener('change', syncProvider);
  syncProvider();
  const follow = h('input', { type: 'checkbox', checked: !!s.follow });
  const word = h('input', { type: 'checkbox', checked: !!s.wordHighlight });
  const subs = h('input', { type: 'checkbox', checked: !!s.subtitles });
  const info = h('p.small.muted', { text: 'Carregando…' });
  window.api.app.info().then((i) => { info.textContent = `Versão ${i.version} · Dados em ${i.userData}`; });

  const save = async () => {
    await store.updateSettings({
      theme: theme.value,
      translationProvider: provider.value,
      deeplKey: deeplKey.value.trim(),
      libreUrl: libreUrl.value.trim(),
      libreKey: libreKey.value.trim(),
      follow: follow.checked,
      wordHighlight: word.checked,
      subtitles: subs.checked
    });
    applyTheme();
    if (reader.book) {
      reader.syncToggles();
      reader.updateSubtitleVisibility();
    }
    ref.close();
    toast('Configurações salvas.', { duration: 1500 });
  };

  const content = h('div', { style: { display: 'contents' } },
    h('h2', { text: 'Configurações' }),
    h('h4', { text: 'Aparência' }),
    h('label.field', {}, h('span.field-label', { text: 'Tema do aplicativo' }), theme),
    h('h4', { text: 'Narração' }),
    h('label.check', {}, follow, 'Rolar a página para acompanhar a frase que está sendo lida'),
    h('label.check', {}, word, 'Destacar também a palavra falada (quando lendo no idioma original)'),
    h('label.check', {}, subs, 'Mostrar legenda com a frase atual durante a narração'),
    h('h4', { text: 'Tradução simultânea' }),
    h('label.field', {}, h('span.field-label', { text: 'Serviço de tradução' }), provider),
    deeplBox,
    libreBox,
    h('p.small.muted', { text: 'As frases são traduzidas pela internet conforme a leitura avança e ficam guardadas em cache para as próximas vezes. As vozes neurais online também enviam o texto ao serviço de voz da Microsoft; as vozes do Windows funcionam totalmente offline.' }),
    h('h4', { text: 'Sobre' }),
    info,
    h('div.modal-actions', {},
      h('button.btn.btn-ghost', { text: 'Cancelar', onclick: () => ref.close() }),
      h('button.btn.btn-primary', { text: 'Salvar', onclick: save }))
  );
  const ref = openModal(content, { wide: true });
}

$('#btn-settings').addEventListener('click', openSettings);

// ---------- Arrastar e soltar PDFs ----------
let dragDepth = 0;
const overlay = $('#drop-overlay');
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  overlay.hidden = false;
});
window.addEventListener('dragover', (e) => {
  if (hasFiles(e)) e.preventDefault();
});
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) overlay.hidden = true;
});
window.addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  overlay.hidden = true;
  const paths = [...e.dataTransfer.files].map((f) => window.api.pathForFile(f)).filter((p) => p && /\.pdf$/i.test(p));
  if (!paths.length) {
    toast('Solte apenas arquivos PDF.', { type: 'error' });
    return;
  }
  const result = await library.addPaths(paths);
  // Se estiver lendo e soltou um único livro novo, oferece abrir.
  const added = result?.added || [];
  if (added.length === 1 && !readerRoot.hidden) {
    toast(`"${added[0].title}" adicionado.`, { action: { label: 'Abrir', onClick: () => openBook(added[0].id) } });
  }
});

// PDFs abertos pelo Explorer ("Abrir com…") ou por outra instância.
window.api.library.onExternalOpen((result) => {
  const res = library.handleAdded(result);
  const target = res?.added?.[0] || (result?.skipped?.[0]?.id ? { id: result.skipped[0].id } : null);
  if (target) setTimeout(() => openBook(target.id), 600);
});

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

// ---------- Inicialização ----------
(async () => {
  hydrateIcons(document);
  await store.load();
  applyTheme();
  library.render();
  library.resumePending();
  // Pré-carrega as vozes neurais em segundo plano para o painel abrir rápido.
  engines.edge.voices().catch(() => {});
  engines.system.voices().catch(() => {});
  window.__app = { store, library, reader };
})();
