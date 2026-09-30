// db.js
// Local-first storage for the kiosk. Everything the kiosk writes goes here
// FIRST, before any network call is attempted. The kiosk should never
// block on connectivity to log a load.
//
// Stores:
//   pending_loads   - append-only queue of field loads logged on this device.
//   shipments       - outbound hauls (bin -> buyer) started on this device.
//   tickets         - scale ticket entries (append-only; newest wins). May
//                      carry a photo Blob until it has uploaded.
//   reference       - cached copy of server data the kiosk needs to
//                      function offline (fields, bins, workers, ...).
//
// Each queue record has synced: false until sync.js confirms it landed.

const DB_NAME = "ufer_kiosk";
const DB_VERSION = 3; // v3 adds ticket_draft — recovers an in-progress scale
// ticket (fields + photo) if the OS reloads the page while the camera is
// open, which on some phones reclaims the browser's memory mid-capture
// and wipes anything that only lived in JS state.

let dbPromise = null;

// One shared connection instead of a fresh one per call. If a newer
// version of the app needs to upgrade the schema, we close ours so the
// upgrade isn't blocked by a stale open tab.
function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
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
      if (!db.objectStoreNames.contains("shipments")) {
        db.createObjectStore("shipments", { keyPath: "localId", autoIncrement: true });
      }
      if (!db.objectStoreNames.contains("tickets")) {
        db.createObjectStore("tickets", { keyPath: "localId", autoIncrement: true });
      }
      if (!db.objectStoreNames.contains("ticket_draft")) {
        db.createObjectStore("ticket_draft", { keyPath: "key" });
      }
    };

    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
    req.onblocked = () => {
      console.warn("Database upgrade is waiting on another open tab of this app — close other tabs.");
    };
  });
  return dbPromise;
}

// --- Small generic helpers for the queue-style stores ---

async function addRecord(storeName, record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const req = tx.objectStore(storeName).add(record);
    req.onsuccess = () => resolve({ ...record, localId: req.result });
    req.onerror = () => reject(req.error);
  });
}

async function allRecords(storeName) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function patchRecord(storeName, localId, patch) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    const getReq = store.get(localId);
    getReq.onsuccess = () => {
      const record = getReq.result;
      if (!record) return resolve();
      const putReq = store.put({ ...record, ...patch });
      putReq.onsuccess = () => resolve();
      putReq.onerror = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

// --- Pending loads (field deliveries) ---

export async function queueLoad(load) {
  return addRecord("pending_loads", {
    ...load,
    synced: false,
    queuedAt: new Date().toISOString(),
    // A device-stable client id lets Supabase de-dupe if the same
    // record gets POSTed twice (e.g. sync succeeded but the response
    // never made it back before connectivity dropped again).
    clientId: crypto.randomUUID(),
  });
}

export async function getPendingLoads() {
  return (await allRecords("pending_loads")).filter((r) => !r.synced);
}

export async function getAllLoads() {
  return allRecords("pending_loads");
}

export async function markSynced(localId) {
  return patchRecord("pending_loads", localId, { synced: true, syncedAt: new Date().toISOString() });
}

// --- Outbound hauls ---

export async function queueShipment(shipment) {
  return addRecord("shipments", {
    ...shipment,
    synced: false,
    departedAt: new Date().toISOString(),
    clientId: crypto.randomUUID(),
  });
}

export async function getAllShipments() {
  return allRecords("shipments");
}

export async function getPendingShipments() {
  return (await allRecords("shipments")).filter((r) => !r.synced);
}

export async function markShipmentSynced(localId) {
  return patchRecord("shipments", localId, { synced: true, syncedAt: new Date().toISOString() });
}

// --- Scale tickets (append-only; a correction is just a newer row) ---

export async function queueTicket(ticket) {
  const clientId = crypto.randomUUID();
  return addRecord("tickets", {
    ...ticket,
    clientId,
    createdAt: new Date().toISOString(),
    synced: false,
    // Where the photo will live in the storage bucket. A new photo gets its
    // own path; a correction without one keeps pointing at the earlier photo.
    photoPath: ticket.photo ? `${ticket.shipmentClientId}/${clientId}.jpg` : ticket.photoPath ?? null,
    photoUploaded: false,
  });
}

export async function getAllTickets() {
  return allRecords("tickets");
}

// A ticket is pending if its data row hasn't synced OR its photo hasn't
// uploaded yet — the two retry independently.
export async function getPendingTickets() {
  return (await allRecords("tickets")).filter((t) => !t.synced || (t.photo && !t.photoUploaded));
}

export async function markTicketSynced(localId) {
  return patchRecord("tickets", localId, { synced: true, syncedAt: new Date().toISOString() });
}

export async function markTicketPhotoUploaded(localId) {
  // Drop the Blob once it's safely uploaded so it doesn't sit in storage.
  return patchRecord("tickets", localId, { photoUploaded: true, photo: null });
}

// --- In-progress scale ticket draft ---
// One row, always overwritten (key is always "current"). Saved right
// before the camera/photo picker opens, and again once a photo is
// attached — the two moments most likely to be followed by the page
// coming back as a reload instead of resuming. Cleared once the ticket
// is actually queued, or the driver explicitly discards it.
const DRAFT_KEY = "current";

export async function saveTicketDraft(draft) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("ticket_draft", "readwrite");
    const req = tx.objectStore("ticket_draft").put({ ...draft, key: DRAFT_KEY, savedAt: new Date().toISOString() });
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function getTicketDraft() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("ticket_draft", "readonly");
    const req = tx.objectStore("ticket_draft").get(DRAFT_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function clearTicketDraft() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("ticket_draft", "readwrite");
    const req = tx.objectStore("ticket_draft").delete(DRAFT_KEY);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// Everything still waiting to reach Supabase — drives the "N queued" badge.
export async function pendingCount() {
  const [loads, ships, tickets] = await Promise.all([getPendingLoads(), getPendingShipments(), getPendingTickets()]);
  return loads.length + ships.length + tickets.length;
}

// --- Reference data cache (fields, bins, workers, destinations, ...) ---

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
