'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('remotePcl', {
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),
  listWindows: () => ipcRenderer.invoke('list-windows'),
  startPipeline: (options) => ipcRenderer.invoke('start-pipeline', options),
  stopPipeline: () => ipcRenderer.invoke('stop-pipeline'),
  copyText: (text) => ipcRenderer.invoke('copy-text', text),
  recordUiEvent: (event, detail) => ipcRenderer.invoke('record-ui-event', { event, detail }),
  onLog: (callback) => ipcRenderer.on('app-log', (_event, data) => callback(data)),
  onPipelineState: (callback) => ipcRenderer.on('pipeline-state', (_event, data) => callback(data)),
  onPreviewState: (callback) => ipcRenderer.on('preview-state', (_event, data) => callback(data)),
  onPreviewFrame: (callback) => ipcRenderer.on('preview-frame', (_event, data) => callback(data)),
  onPairingCode: (callback) => ipcRenderer.on('pairing-code', (_event, data) => callback(data)),
});
