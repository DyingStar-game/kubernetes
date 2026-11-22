'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * The only bridge between the UI and Node. The renderer stays sandboxed with no
 * direct filesystem or child-process access; it can only call the actions the main
 * process chose to expose.
 */
// Fetched once, before the page runs: every text the window shows, in the language of the panel.
let texts = { lang: 'en', strings: {} };
try {
  texts = ipcRenderer.sendSync('panel:i18n') || texts;
} catch { /* a main process from before translations: the page falls back to its keys */ }

contextBridge.exposeInMainWorld('panel', {
  i18n: texts,

  action: (action, payload) => ipcRenderer.invoke('panel:action', action, payload),
  state: () => ipcRenderer.invoke('panel:state'),
  search: (params) => ipcRenderer.invoke('panel:search', params),

  // The settings screen: everything it shows comes from the schema, through these four calls.
  settings: {
    get: () => ipcRenderer.invoke('panel:settings:get'),
    set: (patch) => ipcRenderer.invoke('panel:settings:set', patch),
    setProfile: (choice) => ipcRenderer.invoke('panel:profile:set', choice),
    pickPath: (options) => ipcRenderer.invoke('panel:pick-path', options),
    restart: () => ipcRenderer.invoke('panel:restart'),
  },

  onState: (cb) => {
    const handler = (_e, state) => cb(state);
    ipcRenderer.on('panel:state', handler);
    return () => ipcRenderer.removeListener('panel:state', handler);
  },

  onLogs: (cb) => {
    const handler = (_e, batch) => cb(batch);
    ipcRenderer.on('panel:logs', handler);
    return () => ipcRenderer.removeListener('panel:logs', handler);
  },

  onCleared: (cb) => {
    const handler = (_e, info) => cb(info);
    ipcRenderer.on('panel:cleared', handler);
    return () => ipcRenderer.removeListener('panel:cleared', handler);
  },

  // The setup assistant: one call for the whole picture; what it does goes through `action`.
  setup: {
    get: () => ipcRenderer.invoke('panel:setup:get'),
  },

  // The main process asking the window to show something ("settings", "setup").
  onOpen: (cb) => {
    const handler = (_e, what) => cb(what);
    ipcRenderer.on('panel:open', handler);
    return () => ipcRenderer.removeListener('panel:open', handler);
  },
});
