// sync.js
// Reconciles this kiosk's local queue with Supabase whenever a connection
// is available. Deliberately simple: polling + the browser's online/offline
// events, rather than the Background Sync API (inconsistent browser support,
// and a farm kiosk needs behavior you can predict and explain to a driver).
//
// Usage:
//   import { initSync } from "./sync.js";
//   initSync({
//     supabaseUrl: "https://xxxx.supabase.co",
//     supabaseAnonKey: "...",
//     onStatusChange: (status) => { ... update UI ... },
//   });

import {
  getPendingLoads,
  markSynced,
  cacheReference,
} from "./db.js";

const POLL_INTERVAL_MS = 30_000; // retry every 30s in case 'online' misfires
const REFERENCE_TABLES = ["fields", "bins"]; // extend as the schema grows

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

async function pushPendingLoads() {
  const pending = await getPendingLoads();
  if (pending.length === 0) return { pushed: 0, failed: 0 };

  let pushed = 0;
  let failed = 0;

  for (const load of pending) {
    try {
      // Plain insert only — loads is deliberately insert-only for the
      // kiosk's anon key (no select/update grant), so retry-safety can't
      // rely on an upsert. Instead, a duplicate-key error on retry (the
      // unique constraint on client_id) is treated as success below,
      // since it just means an earlier attempt already landed.
      await supabaseRequest("/rest/v1/loads", {
        method: "POST",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify(toLoadRow(load)),
      });
      await markSynced(load.localId);
      pushed += 1;
    } catch (err) {
      if (err.code === "23505") {
        await markSynced(load.localId);
        pushed += 1;
        continue;
      }
      // Leave it queued — it'll retry next cycle. One failed record
      // should never block the rest of the queue from syncing.
      console.error("Sync failed for load", load.localId, err);
      failed += 1;
    }
  }

  return { pushed, failed };
}

// Maps the kiosk's in-app load shape to the Supabase table's columns.
// Adjust this once the real schema (from the chart of accounts / bin
// design work) is finalized.
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

async function pullReferenceData() {
  for (const table of REFERENCE_TABLES) {
    try {
      const rows = await supabaseRequest(`/rest/v1/${table}?select=*`);
      await cacheReference(table, rows);
      // Lets the running UI (app.js) pick up fresh reference data — e.g. a
      // clean-bin affidavit logged elsewhere — without a manual reload.
      window.dispatchEvent(new CustomEvent("grainchain:reference-updated"));
    } catch (err) {
      // Offline or table not reachable — keep serving the last cached copy.
      console.warn(`Could not refresh reference table "${table}"`, err);
    }
  }
}

export async function runSyncCycle() {
  if (syncing || !navigator.onLine) return;
  syncing = true;
  notify("syncing");
  try {
    const { pushed, failed } = await pushPendingLoads();
    await pullReferenceData();
    const stillPending = (await getPendingLoads()).length;
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
