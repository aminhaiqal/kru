const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('kruBrowser', {
  layout: (input) => ipcRenderer.send('kru:browser-layout', input),
  onState: (listener) => {
    const receive = (_event, state) => listener(state);
    ipcRenderer.on('kru:browser-state', receive);
    return () => ipcRenderer.removeListener('kru:browser-state', receive);
  },
});
