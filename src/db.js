// db.js
// Local-first storage for the kiosk. Everything the kiosk writes goes here
// FIRST, synchronously, before any network call is attempted. The kiosk
// should never block on connectivity to log a load.
//
// Stores:
//   pending_loads   - append-only queue of loads logged on this device,
//                      each with synced: false until the sync module
//                      confirms it landed in Supabase.
//   reference        - cached copy of server data the kiosk needs to
//                      function offline (fields, bins, affidavit status).
//                      Keyed by a string key, e.g. "fields", "bins".

const DB_NAME = "ufer_kiosk";
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains("pending_loads")) {
        const store = db.createObjectStore("pending_loads", {
          keyPath: "localId",
          autoIncrement: true,
        });
        store.createIndex("synced", "synced", { unique: false });
      }
      if (!db.objectStoreNames.contains("reference")) {
        db.createObjectStore("reference", { keyPath: "key" });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// --- Pending loads (the sync queue) ---

export async function queueLoad(load) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("pending_loads", "readwrite");
    const record = {
      ...load,
      synced: false,
      queuedAt: new Date().toISOString(),
      // A device-stable client id lets Supabase de-dupe if the same
      // record gets POSTed twice (e.g. sync succeeded but the response
      // never made it back before connectivity dropped again).
      clientId: crypto.randomUUID(),
    };
    const req = tx.objectStore("pending_loads").add(record);
    req.onsuccess = () => resolve({ ...record, localId: req.result });
    req.onerror = () => reject(req.error);
  });
}

export async function getPendingLoads() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("pending_loads", "readonly");
    const req = tx.objectStore("pending_loads").getAll();
    req.onsuccess = () => resolve(req.result.filter((r) => !r.synced));
    req.onerror = () => reject(req.error);
  });
}

export async function getAllLoads() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("pending_loads", "readonly");
    const req = tx.objectStore("pending_loads").getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function markSynced(localId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("pending_loads", "readwrite");
    const store = tx.objectStore("pending_loads");
    const getReq = store.get(localId);
    getReq.onsuccess = () => {
      const record = getReq.result;
      if (!record) return resolve();
      record.synced = true;
      record.syncedAt = new Date().toISOString();
      const putReq = store.put(record);
      putReq.onsuccess = () => resolve();
      putReq.onerror = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

export async function pendingCount() {
  const loads = await getPendingLoads();
  return loads.length;
}

// --- Reference data cache (fields, bins, affidavit status) ---

export async function cacheReference(key, data) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("reference", "readwrite");
    const req = tx.objectStore("reference").put({
      key,
      data,
      cachedAt: new Date().toISOString(),
    });
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function getReference(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("reference", "readonly");
    const req = tx.objectStore("reference").get(key);
    req.onsuccess = () => resolve(req.result ? req.result.data : null);
    req.onerror = () => reject(req.error);
  });
}
