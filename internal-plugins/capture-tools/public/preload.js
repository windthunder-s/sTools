const { ipcRenderer } = require('electron')
window.captureTools = {
  displays: () => ipcRenderer.invoke('capture-tools:displays'),
  start: (options) => ipcRenderer.invoke('capture-tools:start', options),
  drafts: () => ipcRenderer.invoke('capture-tools:drafts')
}
