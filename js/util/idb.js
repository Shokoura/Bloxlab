// Minimal IndexedDB key/value store with an in-memory fallback (private windows, blocked storage).
const DB_NAME = 'bloxlab';
const STORES = ['projects', 'assets', 'plugins', 'datastores', 'meta'];
let dbp = null;
const memory = new Map(STORES.map((s) => [s, new Map()]));

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    let req;
    try { req = indexedDB.open(DB_NAME, 2); } catch { resolve(null); return; }
    req.onupgradeneeded = () => { for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbp;
}

async function tx(store, mode, fn) {
  const db = await open();
  if (!db) return fn(null);
  return new Promise((resolve, reject) => {
    let result;
    try {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      const r = fn(s);
      if (r && 'onsuccess' in r) r.onsuccess = () => { result = r.result; };
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    } catch (e) { reject(e); }
  });
}

export const idb = {
  async get(store, key) {
    try { const db = await open(); if (!db) return memory.get(store).get(key); return await tx(store, 'readonly', (s) => s.get(key)); }
    catch { return memory.get(store).get(key); }
  },
  async set(store, key, value) {
    try { const db = await open(); if (!db) { memory.get(store).set(key, value); return; } await tx(store, 'readwrite', (s) => s.put(value, key)); }
    catch { memory.get(store).set(key, value); }
  },
  async del(store, key) {
    try { const db = await open(); if (!db) { memory.get(store).delete(key); return; } await tx(store, 'readwrite', (s) => s.delete(key)); }
    catch { memory.get(store).delete(key); }
  },
  async keys(store) {
    try { const db = await open(); if (!db) return [...memory.get(store).keys()]; return await tx(store, 'readonly', (s) => s.getAllKeys()); }
    catch { return [...memory.get(store).keys()]; }
  },
  async clear(store) {
    try { const db = await open(); if (!db) { memory.get(store).clear(); return; } await tx(store, 'readwrite', (s) => s.clear()); }
    catch { memory.get(store).clear(); }
  },
};
