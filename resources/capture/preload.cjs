const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('capture', {
  describe: () => ipcRenderer.invoke('capture:describe'),
  setMode: (mode) => ipcRenderer.invoke('capture:set-mode', mode),
  selectScroll: (crop) => ipcRenderer.invoke('capture:select-scroll', crop),
  scrollFrame: () => ipcRenderer.invoke('capture:scroll-frame'),
  scrollFinish: () => ipcRenderer.invoke('capture:scroll-finish'),
  scrollRetry: () => ipcRenderer.invoke('capture:scroll-retry'),
  opacity: (value) => ipcRenderer.invoke('capture:opacity', value),
  close: () => ipcRenderer.invoke('capture:close'),
  image: (action, data) => ipcRenderer.invoke('capture:image', action, data),
  selectRecording: (crop) => ipcRenderer.invoke('capture:select-recording', crop),
  options: (options) => ipcRenderer.invoke('capture:record-options', options),
  begin: (mime) => ipcRenderer.invoke('capture:record-begin', mime),
  started: () => ipcRenderer.invoke('capture:record-started'),
  abort: () => ipcRenderer.invoke('capture:record-abort'),
  chunk: (bytes) => ipcRenderer.invoke('capture:record-chunk', bytes),
  finish: () => ipcRenderer.invoke('capture:record-finish'),
  save: () => ipcRenderer.invoke('capture:record-save'),
  onStop: (callback) => ipcRenderer.on('capture:stop', () => callback())
})
