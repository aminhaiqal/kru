const { contextBridge, ipcRenderer } = require('electron');
const { exposeClerkBridge } = require('@clerk/electron/preload');
if (process.isMainFrame && globalThis.location?.href.startsWith('kru://app/')) {
  exposeClerkBridge();
  contextBridge.exposeInMainWorld('kruAccount', {
    configuration: () => ipcRenderer.invoke('kru:account-configuration'),
  });
}
contextBridge.exposeInMainWorld('kruBrain', {
  open: (target) => ipcRenderer.invoke('kru:brain-open', target),
});
contextBridge.exposeInMainWorld('kruTheme', {
  get: () => ipcRenderer.sendSync('kru:theme-get'),
  set: (theme) => ipcRenderer.invoke('kru:theme-set', theme),
});
contextBridge.exposeInMainWorld('kruBrowser', {
  openExternal: (agentId) => ipcRenderer.invoke('kru:browser-external', agentId),
  layout: (input) => ipcRenderer.send('kru:browser-layout', input),
  onState: (listener) => {
    const receive = (_event, state) => listener(state);
    ipcRenderer.on('kru:browser-state', receive);
    return () => ipcRenderer.removeListener('kru:browser-state', receive);
  },
});

contextBridge.exposeInMainWorld('kruGitHub', {
  status: () => ipcRenderer.invoke('kru:github-status'),
  saveToken: (token) => ipcRenderer.invoke('kru:github-token', token),
});
