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
//   affidavits      - signed clean-truck affidavits (the signature image is
//                      a Blob here until it has uploaded; see add-truck-affidavits.sql).
//   reference       - cached copy of server data the kiosk needs to
//                      function offline (fields, bins, workers, ...).
//
// Each queue record has synced: false until sync.js confirms it landed.

const DB_NAME = "ufer_kiosk";
const DB_VERSION = 5; // v5 adds the affidavits store (clean-truck affidavits
// signed on a driver's phone; queued here like tickets, uploaded when online).
// v4 adds dryer_readings, dryer_runs, and
// active_dryer_runs — the dryer operator flow. A run only ever becomes a
// dryer_runs record once it's stopped (start + stop + everything in
// between, synced together); while it's running, its state lives in
// active_dryer_runs (keyed by dryer name) so it survives a reload on this
// device, the same reasoning as ticket_draft above. Readings sync
// independently and continuously throughout a run, same as tickets.

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
      if (!db.objectStoreNames.contains("dryer_readings")) {
        db.createObjectStore("dryer_readings", { keyPath: "localId", autoIncrement: true });
      }
      if (!db.objectStoreNames.contains("dryer_runs")) {
        db.createObjectStore("dryer_runs", { keyPath: "localId", autoIncrement: true });
      }
      if (!db.objectStoreNames.contains("active_dryer_runs")) {
        db.createObjectStore("active_dryer_runs", { keyPath: "dryerName" });
      }
      if (!db.objectStoreNames.contains("affidavits")) {
        db.createObjectStore("affidavits", { keyPath: "localId", autoIncrement: true });
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
    // A caller can supply the id up front when something else (a truck
    // affidavit signed just before the haul is saved) has to point at this
    // haul before it exists. Otherwise it's made here, as always.
    clientId: shipment.clientId || crypto.randomUUID(),
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

// --- Clean-truck affidavits (append-only; a correction is a new, superseding row) ---

export async function queueAffidavit(aff) {
  const clientId = aff.clientId || crypto.randomUUID();
  return addRecord("affidavits", {
    ...aff,
    clientId,
    signedAt: aff.signedAt || new Date().toISOString(),
    synced: false,
    // Where the signature image will live in the affidavit-signatures bucket.
    signaturePath: `${clientId}.png`,
    signatureUploaded: false,
  });
}

export async function getAllAffidavits() {
  return allRecords("affidavits");
}

// Pending if the row hasn't synced OR the signature image hasn't uploaded —
// the two are tried in order (image first) so a row never points at a
// signature that isn't there.
export async function getPendingAffidavits() {
  return (await allRecords("affidavits")).filter((a) => !a.synced || !a.signatureUploaded);
}

export async function markAffidavitSynced(localId) {
  return patchRecord("affidavits", localId, { synced: true, syncedAt: new Date().toISOString() });
}

export async function markAffidavitSignatureUploaded(localId) {
  // Drop the image once it's safely uploaded; its hash stays on the record.
  return patchRecord("affidavits", localId, { signatureUploaded: true, signature: null });
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

// --- Dryer readings (sync independently and continuously, like tickets) ---

export async function queueDryerReading(reading) {
  return addRecord("dryer_readings", {
    ...reading,
    synced: false,
    clientId: crypto.randomUUID(),
  });
}

export async function getAllDryerReadings() {
  return allRecords("dryer_readings");
}

export async function getPendingDryerReadings() {
  return (await allRecords("dryer_readings")).filter((r) => !r.synced);
}

export async function markDryerReadingSynced(localId) {
  return patchRecord("dryer_readings", localId, { synced: true, syncedAt: new Date().toISOString() });
}

// --- Dryer runs (written once, at stop — see the DB_VERSION note above) ---

export async function queueDryerRun(run) {
  // Unlike every other queue* function, this does NOT generate a fresh
  // clientId — the caller must pass the SAME id that was already used as
  // runClientId when this run's readings were logged (there's no foreign
  // key between the two tables, so a mismatched id here would silently
  // orphan every reading from this run).
  if (!run.clientId) throw new Error("queueDryerRun: run.clientId is required (must match the runClientId its readings were logged under)");
  return addRecord("dryer_runs", {
    ...run,
    synced: false,
  });
}

export async function getAllDryerRuns() {
  return allRecords("dryer_runs");
}

export async function getPendingDryerRuns() {
  return (await allRecords("dryer_runs")).filter((r) => !r.synced);
}

export async function markDryerRunSynced(localId) {
  return patchRecord("dryer_runs", localId, { synced: true, syncedAt: new Date().toISOString() });
}

// --- Active dryer run per dryer — survives a reload on this device while
// a run is in progress. Keyed by dryer name since Tower Dryer and Super B
// can run independently of each other.

export async function saveActiveDryerRun(dryerName, data) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("active_dryer_runs", "readwrite");
    const req = tx.objectStore("active_dryer_runs").put({ ...data, dryerName });
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function getActiveDryerRun(dryerName) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("active_dryer_runs", "readonly");
    const req = tx.objectStore("active_dryer_runs").get(dryerName);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function getAllActiveDryerRuns() {
  return allRecords("active_dryer_runs");
}

export async function clearActiveDryerRun(dryerName) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("active_dryer_runs", "readwrite");
    const req = tx.objectStore("active_dryer_runs").delete(dryerName);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// Everything still waiting to reach Supabase — drives the "N queued" badge.
export async function pendingCount() {
  const [loads, ships, tickets, readings, runs, affidavits] = await Promise.all([
    getPendingLoads(),
    getPendingShipments(),
    getPendingTickets(),
    getPendingDryerReadings(),
    getPendingDryerRuns(),
    getPendingAffidavits(),
  ]);
  return loads.length + ships.length + tickets.length + readings.length + runs.length + affidavits.length;
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
