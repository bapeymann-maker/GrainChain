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
  getPendingAffidavits,
  markAffidavitSynced,
  markAffidavitSignatureUploaded,
  getPendingDryerReadings,
  markDryerReadingSynced,
  getPendingDryerRuns,
  markDryerRunSynced,
  pendingCount,
  cacheReference,
} from "./db.js";

const POLL_INTERVAL_MS = 30_000; // retry every 30s in case 'online' misfires
const PHOTO_BUCKET = "scale-tickets";
const SIGNATURE_BUCKET = "affidavit-signatures";

const ALL_REFERENCE_TABLES = [
  { key: "fields", endpoint: "fields" },
  { key: "bins", endpoint: "bin_levels" }, // live-computed fill % — see create-bin-levels-view.sql
  { key: "workers", endpoint: "workers" },
  { key: "destinations", endpoint: "destinations" },
  // Recent hauls + newest ticket, so a haul started on one device can be
  // finished from another — see create-outbound-hauls.sql
  { key: "recent_shipments", endpoint: "recent_shipments", query: "select=*&order=departed_at.desc" },
  // Per trailer: its newest clean-truck affidavit (to pre-fill the next one)
  // and the newest thing recorded as hauled in it — see add-truck-affidavits.sql
  { key: "trailer_context", endpoint: "trailer_context" },
];
// Each page says which of these it needs via initSync({ reference: [...] });
// the kiosk (index.html) passes nothing and gets the original three.
const DEFAULT_REFERENCE_KEYS = ["fields", "bins", "workers"];

// Operations tracked in the owner's Harvest tab that don't deliver grain
// through the kiosk or Deliveries — their fields live in the same table,
// but must never show up as a place a driver can pick up a load from.
const HIDDEN_FROM_PICKERS_OPERATIONS = ["LB Pork"];

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

// contentType: say it explicitly when the bucket only accepts one kind —
// a stored Blob can come back from the browser's database without its type,
// and the fallback below (JPEG) would be refused by a PNG-only bucket.
async function uploadPhoto(path, blob, bucket = PHOTO_BUCKET, contentType = null) {
  const res = await fetch(`${config.supabaseUrl}/storage/v1/object/${bucket}/${path}`, {
    method: "POST",
    headers: {
      apikey: config.supabaseAnonKey,
      Authorization: `Bearer ${config.supabaseAnonKey}`,
      "Content-Type": contentType || blob.type || "image/jpeg",
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

// A signed affidavit is a legal record, so it's pushed in a fixed order:
// the signature image first, THEN the row that points at it. If the image
// can't upload (weak signal), the row waits too — better a short delay
// than a row on the server whose signature doesn't exist. Each step is
// remembered separately, so a retry never repeats the part that worked.
async function pushPendingAffidavits() {
  let pushed = 0;
  let failed = 0;
  for (const a of await getPendingAffidavits()) {
    if (!a.signatureUploaded) {
      try {
        await uploadPhoto(a.signaturePath, a.signature, SIGNATURE_BUCKET, "image/png");
        await markAffidavitSignatureUploaded(a.localId);
      } catch (err) {
        console.error("Signature upload failed for affidavit", a.localId, err);
        failed += 1;
        continue;
      }
    }
    if (!a.synced) {
      try {
        await insertRow("truck_affidavits", toAffidavitRow(a));
        await markAffidavitSynced(a.localId);
        pushed += 1;
      } catch (err) {
        console.error("Sync failed for affidavit", a.localId, err);
        failed += 1;
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

// record_hash is deliberately absent: the database computes it itself, and
// ignores anything sent for it.
function toAffidavitRow(a) {
  return {
    client_id: a.clientId,
    signed_at: a.signedAt,
    worker_id: a.workerId,
    truck: a.truck ?? null,
    trailer: a.trailer,
    context: a.context,
    shipment_client_id: a.shipmentClientId ?? null,
    origin_type: a.originType,
    field_id: a.fieldId ?? null,
    bin_id: a.binId ?? null,
    origin_status: a.originStatus,
    crop: a.crop ?? null,
    condition: a.condition,
    cleaning_methods: a.cleaningMethods || [],
    statement: a.statement,
    signature_path: a.signaturePath,
    signature_sha256: a.signatureSha256,
    supersedes: a.supersedes ?? null,
  };
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
    // Carried on every reading (not just known via the run) so any
    // device can reconstruct "what's running right now" from synced
    // readings alone — see add-dryer-cross-device-status.sql.
    source_bin_id: r.sourceBinId ?? null,
    dest_bin_id: r.destBinId ?? null,
    crop: r.crop ?? null,
    status: r.status ?? null,
  };
}

// Supabase's row shape (snake_case) back to the kiosk's own in-app
// reading shape (camelCase) — the reverse of toDryerReadingRow, used
// when pulling another device's readings for a run this browser didn't
// start itself.
function fromDryerReadingRow(row) {
  return {
    clientId: row.client_id,
    runClientId: row.run_client_id,
    dryerName: row.dryer_name,
    recordedAt: row.recorded_at,
    wetPctIn: row.wet_pct_in,
    dryPctOut: row.dry_pct_out,
    dryTemp: row.dry_temp,
    midgrainTemp: row.midgrain_temp,
    dischargeRate: row.discharge_rate,
    plenumTemp: row.plenum_temp,
    notes: row.notes,
    workerId: row.worker_id,
    synced: true, // this came FROM the server — it's already synced by definition
  };
}

// The server's view of what's running on each dryer right now,
// reconstructed purely from synced readings — not from any one
// browser's local storage. Returns only dryers that ARE running; an
// idle dryer just doesn't appear. Never throws — callers get an empty
// list if offline or the request fails, same as pullReferenceData.
export async function pullDryerStatus() {
  try {
    const rows = await supabaseRequest(`/rest/v1/dryer_current_status?is_running=eq.true&select=*`);
    return (rows || []).map((row) => ({
      dryerName: row.dryer_name,
      runClientId: row.run_client_id,
      sourceBinId: row.source_bin_id,
      destBinId: row.dest_bin_id,
      crop: row.crop,
      status: row.status,
      startedAt: row.started_at,
    }));
  } catch (err) {
    console.warn("Could not pull dryer status", err);
    // null (not []) on failure — distinct from a genuinely empty result,
    // so the caller can tell "server confirms nothing is running" apart
    // from "couldn't ask the server at all." Treating a failed request
    // as confirmed-empty would wipe out a legitimately running local run
    // every time the kiosk is briefly offline.
    return null;
  }
}

// Every reading for one run, from the server — used when a browser
// adopts a run it didn't start, so its readings list and "previous
// entry" default are correct even though they were logged elsewhere.
export async function pullDryerReadingsForRun(runClientId) {
  try {
    const rows = await supabaseRequest(`/rest/v1/dryer_readings?run_client_id=eq.${encodeURIComponent(runClientId)}&select=*&order=recorded_at.asc`);
    return (rows || []).map(fromDryerReadingRow);
  } catch (err) {
    console.warn("Could not pull readings for run", runClientId, err);
    return [];
  }
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
      let rows = await supabaseRequest(`/rest/v1/${endpoint}?${query}`);
      // Filtered here rather than in the query itself so it works whether
      // or not the operation column exists yet (no deploy-order trap), and
      // applies to everything that reads cached fields — kiosk and
      // Deliveries both.
      if (key === "fields" && Array.isArray(rows)) {
        rows = rows.filter((f) => !HIDDEN_FROM_PICKERS_OPERATIONS.includes(f.operation));
      }
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
      await pushPendingAffidavits(),
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
