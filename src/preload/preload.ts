// src/preload/preload.ts
// Sandboxed preload. Two jobs:
//   1. Load the SmartSpectra preload bridge, which owns the MessagePort that
//      the renderer-side SDK uses to reach the native session in main.
//   2. Expose a tiny, explicit `window.viva` API. No Node, no ipcRenderer
//      leak — only these named methods.
//
// Bundled by esbuild into dist/preload.cjs because a sandboxed preload cannot
// require from node_modules at runtime.

// Side-effect import: defines window.__smartspectraBridge via contextBridge.
import '@smartspectra/node-sdk/preload';

import { contextBridge, ipcRenderer } from 'electron';

import type { Settings } from '../shared/types';

const viva = {
  getConfig: () => ipcRenderer.invoke('viva:getConfig'),
  getApiKey: () => ipcRenderer.invoke('viva:getApiKey'),
  setApiKey: (key: string) => ipcRenderer.invoke('viva:setApiKey', key),
  clearApiKey: () => ipcRenderer.invoke('viva:clearApiKey'),
  saveSettings: (patch: Partial<Settings>) => ipcRenderer.invoke('viva:saveSettings', patch),
  saveSession: (record: unknown) => ipcRenderer.invoke('viva:saveSession', record),
  listSessions: () => ipcRenderer.invoke('viva:listSessions'),
  getSession: (id: string) => ipcRenderer.invoke('viva:getSession', id),
  deleteSession: (id: string) => ipcRenderer.invoke('viva:deleteSession', id),
  deleteAllData: () => ipcRenderer.invoke('viva:deleteAllData'),
  openDataFolder: () => ipcRenderer.invoke('viva:openDataFolder'),
  savePng: (dataUrl: string, suggestedName: string) =>
    ipcRenderer.invoke('viva:savePng', dataUrl, suggestedName),
  log: (line: string) => ipcRenderer.send('viva:log', line),
};

contextBridge.exposeInMainWorld('viva', viva);
