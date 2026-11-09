'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('api', {
  library: {
    list: () => invoke('library:list'),
    pick: () => invoke('library:pick'),
    addPaths: (paths) => invoke('library:addPaths', paths),
    update: (id, patch) => invoke('library:update', id, patch),
    remove: (id) => invoke('library:remove', id),
    readPdf: (id) => invoke('library:readPdf', id),
    saveCover: (id, bytes) => invoke('library:saveCover', id, bytes),
    reveal: (id) => invoke('library:reveal', id),
    onExternalOpen: (cb) => ipcRenderer.on('library:external-open', (_e, payload) => cb(payload))
  },
  settings: {
    get: () => invoke('settings:get'),
    set: (patch) => invoke('settings:set', patch)
  },
  tts: {
    voices: (force) => invoke('tts:voices', force),
    synthesize: (req) => invoke('tts:synthesize', req)
  },
  translate: {
    text: (req) => invoke('translate:text', req),
    detect: (text) => invoke('translate:detect', text)
  },
  exporter: {
    begin: (opts) => invoke('export:begin', opts),
    append: (id, bytes) => invoke('export:append', id, bytes),
    end: (id, opts) => invoke('export:end', id, opts),
    reveal: (filePath) => invoke('export:reveal', filePath)
  },
  media: {
    enableKeys: (enable) => invoke('media:keys', enable),
    onKey: (cb) => ipcRenderer.on('media:key', (_e, action) => cb(action))
  },
  app: {
    info: () => invoke('app:info'),
    openExternal: (url) => invoke('app:openExternal', url),
    setTitle: (title) => invoke('app:setTitle', title),
    toggleFullscreen: () => invoke('app:fullscreen')
  },
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return ''; }
  }
});
