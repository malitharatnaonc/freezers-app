import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('freezersAPI', {
  loadSnapshot: (requestedPath) => ipcRenderer.invoke('snapshot:load', requestedPath),
  saveSnapshot: (snapshot) => ipcRenderer.invoke('snapshot:save', snapshot),
  saveSnapshotAs: (snapshot) => ipcRenderer.invoke('snapshot:saveAs', snapshot),
  openSnapshot: () => ipcRenderer.invoke('snapshot:open'),
  importWorkbook: () => ipcRenderer.invoke('workbook:import'),
  exportWorkbook: (snapshot) => ipcRenderer.invoke('workbook:export', snapshot),
})
