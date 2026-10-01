const {contextBridge, ipcRenderer, webUtils} = require('electron');
contextBridge.exposeInMainWorld('desktop', {
  getConfig:()=>ipcRenderer.invoke('get-config'),
  openFile:()=>ipcRenderer.invoke('open-file'),
  loadFile:file=>ipcRenderer.invoke('load-file',file),
  reloadCurrent:()=>ipcRenderer.invoke('reload-current'),
  replaceBlocks:request=>ipcRenderer.invoke('replace-blocks',request),
  editHistory:kind=>ipcRenderer.invoke('edit-history',kind),
  saveLitematic:()=>ipcRenderer.invoke('save-litematic'),
  blockCatalog:()=>ipcRenderer.invoke('block-catalog'),
  droppedPath:file=>webUtils.getPathForFile(file),
  chooseResources:kind=>ipcRenderer.invoke('choose-resources',kind),
  useResource:file=>ipcRenderer.invoke('use-resource',file),
  saveExport:request=>ipcRenderer.invoke('save-export',request),
  showExport:file=>ipcRenderer.invoke('show-export',file),
  onProgress:callback=>{const fn=(_event,text)=>callback(text);ipcRenderer.on('load-progress',fn);return()=>ipcRenderer.removeListener('load-progress',fn);}
});
