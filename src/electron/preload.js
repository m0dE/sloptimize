// ============================================================
// sloptimize/electron/preload — the renderer's bridge to the IPC sink
// ============================================================
// Runs in the preload script. Publishes `window.sloptimizeSink` with the
// two calls the game's drain and the debugger panel need:
//   post(kind, payload) → the same {kind, payload} the dev endpoint took
//   history()           → { records, fixes } for createPanel({ history })
// With contextIsolation off (no contextBridge) the API is assigned onto
// globalThis directly; the game code is identical either way.
export function exposeSloptimizeBridge(opts = {}) {
  const { contextBridge, ipcRenderer } = opts;
  if (!ipcRenderer || typeof ipcRenderer.invoke !== 'function') throw new Error('exposeSloptimizeBridge: ipcRenderer is required');
  const name = opts.name ?? 'sloptimizeSink';
  const channel = opts.channel ?? 'sloptimize';
  const api = {
    post: (kind, payload) => ipcRenderer.invoke(`${channel}:ingest`, { kind, payload }),
    history: () => ipcRenderer.invoke(`${channel}:ledger`),
  };
  if (contextBridge && typeof contextBridge.exposeInMainWorld === 'function') contextBridge.exposeInMainWorld(name, api);
  else (opts.target ?? globalThis)[name] = api;
  return api;
}
