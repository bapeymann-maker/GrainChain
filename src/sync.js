// sync.js
// Reconciles this kiosk's local queues with Supabase whenever a connection
// is available. Deliberately simple: polling + the browser's online/offline
// events, rather than the Background Sync API (inconsistent browser support,
// and a farm kiosk needs behavior you can predict and explain to a driver).
//
// Usage:
//   import { initSync } from "./sync.js";
//   initSync({
//     supabaseUrl: "https://xxxx.supabase.co",
//     supabaseAnonKey: "...",
//     reference: ["bins", "workers"],   // optional: which reference tables this page needs
//     onStatusChange: (status) => { ... update UI ... },
//   });

import {
  getPendingLoads,
  markSynced,
  getPendingShipments,
  markShipmentSynced,
  getPendingTickets,
  markTicketSynced,
  markTicketPhotoUploaded,
  getPendingDryerReadings,
  markDryerReadingSynced,
  getPendingDryerRuns,
  markDryerRunSynced,
  pendingCount,
  cacheReference,
} from "./db.js";

const POLL_INTERVAL_MS = 30_000; // retry every 30s in case 'online' misfires
const PHOTO_BUCKET = "scale-tickets";

const ALL_REFERENCE_TABLES = [
  { key: "fields", endpoint: "fields" },
  { key: "bins", endpoint: "bin_levels" }, // live-computed fill % — see create-bin-levels-view.sql
  { key: "workers", endpoint: "workers" },
  { key: "destinations", endpoint: "destinations" },
  // Recent hauls + newest ticket, so a haul started on one device can be
  // finished from another — see create-outbound-hauls.sql
  { key: "recent_shipments", endpoint: "recent_shipments", query: "select=*&order=departed_at.desc" },
];
// Each page says which of these it needs via initSync({ reference: [...] });
// the kiosk (index.html) passes nothing and gets the original three.
const DEFAULT_REFERENCE_KEYS = ["fields", "bins", "workers"];

let config = null;
let syncing = false;
let pollTimer = null;

function notify(status) {
  if (config?.onStatusChange) config.onStatusChange(status);
}

async function supabaseRequest(path, options = {}) {
  const res = await fetch(`${config.supabaseUrl}${path}`, {
    ...options,
    headers: {
      apikey: config.supabaseAnonKey,
      Authorization: `Bearer ${config.supabaseAnonKey}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // non-JSON error body — leave parsed as null, message text still captured below
    }
    const err = new Error(`Supabase request failed (${res.status}): ${text}`);
    err.status = res.status;
    err.code = parsed?.code; // Postgres SQLSTATE, e.g. "23505" for a unique-constraint conflict
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

// Plain insert of one queued record. Every synced table is insert-only for
// the kiosk's anon key (no select/update grant), so retry-safety can't rely
// on an upsert. Instead, a duplicate-key error on retry (the unique
// constraint on client_id) is treated as success — it just means an
// earlier attempt already landed.
async function insertRow(table, row) {
  try {
    await supabaseRequest(`/rest/v1/${table}`, {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(row),
    });
  } catch (err) {
    if (err.code === "23505") return;
    throw err;
  }
}

async function pushPendingLoads() {
  let pushed = 0;
  let failed = 0;
  for (const load of await getPendingLoads()) {
    try {
      await insertRow("loads", toLoadRow(load));
      await markSynced(load.localId);
      pushed += 1;
    } catch (err) {
      // Leave it queued — it'll retry next cycle. One failed record
      // should never block the rest of the queue from syncing.
      console.error("Sync failed for load", load.localId, err);
      failed += 1;
    }
  }
  return { pushed, failed };
}

async function pushPendingShipments() {
  let pushed = 0;
  let failed = 0;
  for (const s of await getPendingShipments()) {
    try {
      await insertRow("shipments", toShipmentRow(s));
      await markShipmentSynced(s.localId);
      pushed += 1;
    } catch (err) {
      console.error("Sync failed for haul", s.localId, err);
      failed += 1;
    }
  }
  return { pushed, failed };
}

async function uploadPhoto(path, blob) {
  const res = await fetch(`${config.supabaseUrl}/storage/v1/object/${PHOTO_BUCKET}/${path}`, {
    method: "POST",
    headers: {
      apikey: config.supabaseAnonKey,
      Authorization: `Bearer ${config.supabaseAnonKey}`,
      "Content-Type": blob.type || "image/jpeg",
      "x-upsert": "false",
    },
    body: blob,
  });
  if (res.ok) return;
  const text = await res.text().catch(() => "");
  // Already uploaded by an earlier attempt whose response got lost — fine.
  if (res.status === 409 || /duplicate|already exists/i.test(text)) return;
  throw new Error(`Photo upload failed (${res.status}): ${text}`);
}

// A ticket's data row and its photo retry independently, so a slow photo
// upload never holds the weights/ticket number back from syncing.
async function pushPendingTickets() {
  let pushed = 0;
  let failed = 0;
  for (const t of await getPendingTickets()) {
    let ok = true;
    if (!t.synced) {
      try {
        await insertRow("shipment_tickets", toTicketRow(t));
        await markTicketSynced(t.localId);
        pushed += 1;
      } catch (err) {
        console.error("Sync failed for ticket", t.localId, err);
        ok = false;
        failed += 1;
      }
    }
    if (t.photo && !t.photoUploaded) {
      try {
        await uploadPhoto(t.photoPath, t.photo);
        await markTicketPhotoUploaded(t.localId);
      } catch (err) {
        console.error("Photo upload failed for ticket", t.localId, err);
        if (ok) failed += 1;
      }
    }
  }
  return { pushed, failed };
}

// Readings sync continuously and independently throughout a run — no
// foreign key to dryer_runs (see add-dryer-batches.sql), so this can
// land before, after, or without its run ever syncing at all.
async function pushPendingDryerReadings() {
  let pushed = 0;
  let failed = 0;
  for (const r of await getPendingDryerReadings()) {
    try {
      await insertRow("dryer_readings", toDryerReadingRow(r));
      await markDryerReadingSynced(r.localId);
      pushed += 1;
    } catch (err) {
      console.error("Sync failed for dryer reading", r.localId, err);
      failed += 1;
    }
  }
  return { pushed, failed };
}

// A run only ever reaches this queue once it's been stopped (see
// stopDryerRun in app.js) — start and end are already both known by the
// time this is pushed.
async function pushPendingDryerRuns() {
  let pushed = 0;
  let failed = 0;
  for (const run of await getPendingDryerRuns()) {
    try {
      await insertRow("dryer_runs", toDryerRunRow(run));
      await markDryerRunSynced(run.localId);
      pushed += 1;
    } catch (err) {
      console.error("Sync failed for dryer run", run.localId, err);
      failed += 1;
    }
  }
  return { pushed, failed };
}

// Maps the kiosk's in-app load shape to the Supabase table's columns.
function toLoadRow(load) {
  return {
    client_id: load.clientId,
    logged_at: load.queuedAt,
    worker_id: load.workerId,
    field_id: load.fieldId,
    crop: load.crop ?? null,
    truck: load.truck,
    truck_mode: load.truckMode, // "full" | "notFull" | "buffer"
    bushels: load.bushels ?? null,
    weight_lb: load.weightLb ?? null,
    moisture_pct: load.moisturePct ?? null,
    test_weight: load.testWeight ?? null,
    bin_id: load.binId,
    is_buffer: load.isBuffer,
    device_id: config.deviceId,
  };
}

function toShipmentRow(s) {
  return {
    client_id: s.clientId,
    departed_at: s.departedAt,
    worker_id: s.workerId,
    truck: s.truck ?? null,
    trailer: s.trailer,
    origin_type: s.originType || "bin",
    bin_id: s.binId ?? null,
    field_id: s.fieldId ?? null,
    crop: s.crop ?? null,
    bin_status: s.binStatus ?? null,
    origin_status: s.originStatus ?? null,
    split_partner_id: s.splitPartnerId ?? null,
    split_pct: s.splitPct ?? null,
    destination_id: s.destinationId ?? null,
    destination_name: s.destinationName ?? null,
    destination_location: s.destinationLocation ?? null,
    est_bushels: s.estBushels ?? null,
    est_weight_lb: s.estWeightLb ?? null,
    device_id: config.deviceId,
  };
}

function toTicketRow(t) {
  return {
    client_id: t.clientId,
    shipment_client_id: t.shipmentClientId,
    created_at: t.createdAt,
    worker_id: t.workerId ?? null,
    ticket_number: t.ticketNumber || null,
    gross_lb: t.grossLb ?? null,
    tare_lb: t.tareLb ?? null,
    net_lb: t.netLb ?? null,
    net_bushels: t.netBushels ?? null,
    moisture_pct: t.moisturePct ?? null,
    test_weight: t.testWeight ?? null,
    photo_path: t.photoPath ?? null,
    notes: t.notes || null,
    device_id: config.deviceId,
  };
}

function toDryerReadingRow(r) {
  return {
    client_id: r.clientId,
    run_client_id: r.runClientId,
    dryer_name: r.dryerName,
    recorded_at: r.recordedAt,
    wet_pct_in: r.wetPctIn ?? null,
    dry_pct_out: r.dryPctOut ?? null,
    dry_temp: r.dryTemp ?? null,
    midgrain_temp: r.midgrainTemp ?? null,
    discharge_rate: r.dischargeRate ?? null, // 0-100 dial setting, not bu/hr — see add-dryer-batches.sql
    plenum_temp: r.plenumTemp ?? null,
    notes: r.notes || null,
    worker_id: r.workerId ?? null,
    device_id: config.deviceId,
  };
}

function toDryerRunRow(run) {
  return {
    client_id: run.clientId, // must match the runClientId its readings were already logged under — see queueDryerRun in db.js
    dryer_name: run.dryerName,
    source_bin_id: run.sourceBinId ?? null,
    dest_bin_id: run.destBinId,
    crop: run.crop,
    status: run.status,
    started_at: run.startedAt,
    ended_at: run.endedAt,
    bushels_moved_actual: run.bushelsMovedActual ?? null,
    worker_id: run.workerId ?? null,
    notes: run.notes || null,
    device_id: config.deviceId,
  };
}

async function pullReferenceData() {
  let anyUpdated = false;
  const wanted = config.reference || DEFAULT_REFERENCE_KEYS;
  for (const { key, endpoint, query = "select=*" } of ALL_REFERENCE_TABLES.filter((t) => wanted.includes(t.key))) {
    try {
      const rows = await supabaseRequest(`/rest/v1/${endpoint}?${query}`);
      await cacheReference(key, rows);
      anyUpdated = true;
    } catch (err) {
      // Offline or table not reachable — keep serving the last cached copy.
      console.warn(`Could not refresh reference table "${key}"`, err);
    }
  }
  // One event per cycle (not one per table) so the UI refreshes once.
  if (anyUpdated) window.dispatchEvent(new CustomEvent("grainchain:reference-updated"));
}

export async function runSyncCycle() {
  if (!config || syncing || !navigator.onLine) return; // config is set by initSync()
  syncing = true;
  notify("syncing");
  try {
    const parts = [
      await pushPendingLoads(),
      await pushPendingShipments(),
      await pushPendingTickets(),
      await pushPendingDryerReadings(),
      await pushPendingDryerRuns(),
    ];
    const pushed = parts.reduce((n, p) => n + p.pushed, 0);
    const failed = parts.reduce((n, p) => n + p.failed, 0);
    await pullReferenceData();
    const stillPending = await pendingCount();
    notify(
      failed > 0
        ? { state: "partial", pushed, failed, pending: stillPending }
        : { state: "synced", pushed, pending: stillPending }
    );
  } catch (err) {
    console.error("Sync cycle error", err);
    notify({ state: "error", message: err.message });
  } finally {
    syncing = false;
  }
}

// Lets the UI kick a sync right after saving something, instead of
// waiting up to 30s for the next poll.
export function syncSoon() {
  setTimeout(runSyncCycle, 500);
}

export function initSync(cfg) {
  config = {
    deviceId: cfg.deviceId || getOrCreateDeviceId(),
    ...cfg,
  };

  window.addEventListener("online", runSyncCycle);
  window.addEventListener("offline", () => notify("offline"));

  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(runSyncCycle, POLL_INTERVAL_MS);

  // Try once immediately on startup.
  runSyncCycle();
}

function getOrCreateDeviceId() {
  const key = "kiosk_device_id";
  let id = localStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(key, id);
  }
  return id;
}
