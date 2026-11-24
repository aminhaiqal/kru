const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('kruBrain', {
  open: (target) => ipcRenderer.invoke('kru:brain-open', target),
});
contextBridge.exposeInMainWorld('kruTheme', {
  get: () => ipcRenderer.sendSync('kru:theme-get'),
  set: (theme) => ipcRenderer.invoke('kru:theme-set', theme),
});
contextBridge.exposeInMainWorld('kruBrowser', {
  layout: (input) => ipcRenderer.send('kru:browser-layout', input),
  onState: (listener) => {
    const receive = (_event, state) => listener(state);
    ipcRenderer.on('kru:browser-state', receive);
    return () => ipcRenderer.removeListener('kru:browser-state', receive);
  },
});
