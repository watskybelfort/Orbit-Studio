import { contextBridge } from 'electron';

// API mínima; crece con IPC tipado en la fase del shell.
contextBridge.exposeInMainWorld('orbit', {
  version: '0.1.0',
});
