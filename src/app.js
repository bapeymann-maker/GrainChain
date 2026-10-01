// app.js
// The real kiosk flow: PIN login → field → truck/load → bin → confirm.
// No framework — plain DOM building (see the `h()` helper below) so this
// stays a zero-build static site. Every write goes through queueLoad() in
// db.js first; sync.js pushes to Supabase in the background whenever the
// Chromebook has a connection.

import {
  queueLoad,
  getReference,
  getAllLoads,
  queueDryerReading,
  queueDryerRun,
  getAllDryerReadings,
  saveActiveDryerRun,
  getActiveDryerRun,
  getAllActiveDryerRuns,
  clearActiveDryerRun,
} from "./db.js";

// Worker roster (id, name, pin) comes from Supabase's `workers` table via
// getReference("workers") — see state.workers below. Note: PINs are
// pulled to the client the same way fields/bins are, so they're visible
// in this browser's IndexedDB/DevTools to anyone with access to the
// kiosk. Fine for an internal crew roster; if that's ever not fine,
// swap PIN verification for a server-side check (Supabase Edge
// Function) instead of comparing against the full local list.

// Per-truck bushel capacity when a truck is marked full — all 8 confirmed at 1000 bu.
const TRUCKS = ["U1", "U2", "U3", "U4", "U5", "U6", "U7", "U8"];
const TRUCK_BUSHELS = { U1: 1000, U2: 1000, U3: 1000, U4: 1000, U5: 1000, U6: 1000, U7: 1000, U8: 1000 };
const CROPS = ["Corn", "Soybeans", "Oats"];

const COLORS = {
  ink: "#171B1E",
  panel: "#1F2529",
  panelAlt: "#262D32",
  border: "#343B40",
  gold: "#D4A017",
  goldDark: "#3A2F0E",
  amber: "#E2812B",
  amberDark: "#3A250D",
  organic: "#5C8A3A",
  organicDark: "#1D2A13",
  transitional: "#B08F5A",
  transitionalDark: "#2F2717",
  conventional: "#6B7480",
  conventionalDark: "#20242A",
  danger: "#C0453A",
  dangerDark: "#331512",
  text: "#F4F1E9",
  textMuted: "#9AA2A8",
};
const HEAD = "font-family:'Bahnschrift','DIN Alternate','Arial Narrow',sans-serif;";
const BODY = "font-family:Inter,-apple-system,'Segoe UI',sans-serif;";

const STATUS_LABEL = {
  organic: { fg: COLORS.organic, bg: COLORS.organicDark, label: "Organic" },
  transitional: { fg: COLORS.transitional, bg: COLORS.transitionalDark, label: "Transitional" },
  conventional: { fg: COLORS.conventional, bg: COLORS.conventionalDark, label: "Conventional" },
};

// ---------------------------------------------------------------------
// Tiny DOM builder — h(tag, props, children). Keeps this framework-free
// while staying legible. Uses textContent/DOM APIs throughout (never
// innerHTML with real data) so field/bin names from Supabase can never
// break rendering or inject markup.
// ---------------------------------------------------------------------
function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (k === "style" && typeof v === "string") el.style.cssText = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "class") el.className = v;
    else if (k === "checked") el.checked = v;
    else if (k === "disabled") el.disabled = v;
    else if (k === "value") el.value = v;
    else el.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    el.appendChild(typeof child === "string" || typeof child === "number" ? document.createTextNode(child) : child);
  }
  return el;
}

function badge(status) {
  const s = STATUS_LABEL[status];
  if (!s) return h("span");
  return h(
    "span",
    { style: `${BODY}font-size:12px;font-weight:700;color:${s.fg};background:${s.bg};padding:4px 10px;border-radius:999px;white-space:nowrap;` },
    s.label
  );
}

function bigButton(label, { onClick, tone = "default", sub, disabled = false } = {}) {
  const tones = {
    default: { bg: COLORS.panelAlt, border: COLORS.border, fg: COLORS.text },
    gold: { bg: COLORS.goldDark, border: COLORS.gold, fg: COLORS.gold },
  };
  const t = tones[tone];
  const btn = h(
    "button",
    {
      style: `${BODY}width:100%;text-align:left;padding:18px 20px;border-radius:10px;border:1px solid ${t.border};background:${t.bg};color:${t.fg};font-size:17px;font-weight:600;cursor:${disabled ? "not-allowed" : "pointer"};opacity:${disabled ? 0.4 : 1};min-height:64px;display:flex;flex-direction:column;justify-content:center;gap:4px;`,
      onclick: disabled ? null : onClick,
      disabled,
    },
    [h("span", {}, label), sub ? h("span", { style: `font-size:13px;font-weight:400;color:${COLORS.textMuted};` }, sub) : null]
  );
  return btn;
}

function linkButton(label, onClick, color = COLORS.textMuted) {
  return h(
    "button",
    { style: `${BODY}font-size:13px;color:${color};background:none;border:none;cursor:pointer;`, onclick: onClick },
    label
  );
}

// ---------------------------------------------------------------------
// State — one mutable object, one root render() on every change. A kiosk
// has one user at a time, so this doesn't need anything fancier.
// ---------------------------------------------------------------------
const state = {
  screen: "login",
  pin: "",
  pinError: "",
  worker: null,

  fields: [],
  bins: [],
  workers: [],
  statusFilter: "All",
  cropChoice: null,

  field: null,
  bin: null,
  truck: null,
  truckMode: null, // "full" | "notFull" | "buffer"
  weight: "",
  weightUnit: "lb", // "lb" | "bu" — only relevant for notFull/buffer
  weightError: "",
  moisture: "",
  testWeight: "",
  isBuffer: false,

  todayLog: [],

  // --- Dryer operator flow ---
  // dryerActive: current run per dryer, loaded from IndexedDB on mount —
  // null means idle. { runClientId, sourceBinId, destBinId, crop, status,
  // startedAt, workerId }
  dryerActive: { "Tower Dryer": null, "Super B": null },
  dryerCurrent: null, // which dryer the operator is currently viewing/acting on
  dryerReadings: [], // this run's readings so far, for the live estimate + recent list
  // Folds the run's own setup together with its baseline reading — the
  // step-function math (see add-dryer-batches.sql) needs a reading
  // exactly at the run's start, so this screen captures both in one go.
  dryerStartForm: { sourceBinId: "", destBinId: "", crop: "", status: "", wetPctIn: "", dryPctOut: "", dryTemp: "", midgrainTemp: "", dischargeRate: "", plenumTemp: "", notes: "" },
  dryerReadingForm: { wetPctIn: "", dryPctOut: "", dryTemp: "", midgrainTemp: "", dischargeRate: "", plenumTemp: "", notes: "" },
  dryerStopForm: { actualBushels: "", notes: "" },
  // Mandatory-field validation for discharge rate can't be a disabled
  // button — the numeric fields deliberately skip re-rendering on input
  // (to avoid losing focus mid-keystroke), so a disabled state computed
  // at render time would go stale the instant the operator finished
  // typing. Validated on submit instead, same pattern as weightError
  // above.
  dryerFormError: "",
};

let root = null;
let lastScreen = null;

function setState(patch) {
  Object.assign(state, patch);
  render();
  resetInactivityTimer();
}

async function refreshReference() {
  const [fields, bins, workers] = await Promise.all([getReference("fields"), getReference("bins"), getReference("workers")]);
  const patch = { fields: fields || [], bins: bins || [], workers: workers || [] };
  // Background syncs refresh this every ~30s. If someone is mid-typing,
  // update the data quietly instead of re-drawing the screen — a redraw
  // would drop keyboard focus.
  const typing = ["INPUT", "TEXTAREA"].includes(document.activeElement && document.activeElement.tagName);
  if (typing) Object.assign(state, patch);
  else setState(patch);
}

async function refreshTodayLog() {
  const all = await getAllLoads();
  const today = new Date().toDateString();
  const todays = all
    .filter((l) => new Date(l.queuedAt).toDateString() === today)
    .sort((a, b) => new Date(b.queuedAt) - new Date(a.queuedAt));
  setState({ todayLog: todays });
}

// Restores any in-progress dryer run(s) from IndexedDB — the whole reason
// active_dryer_runs exists: if this device reloads mid-run, the operator
// shouldn't come back to "Idle" and lose track of a run that's still
// physically going.
async function restoreActiveDryerRuns() {
  const [rows, readings] = await Promise.all([getAllActiveDryerRuns(), getAllDryerReadings()]);
  const active = { "Tower Dryer": null, "Super B": null };
  rows.forEach((r) => { active[r.dryerName] = r; });
  setState({ dryerActive: active, dryerReadings: readings });
}

function clearTruckFields() {
  Object.assign(state, {
    truck: null,
    truckMode: null,
    weight: "",
    weightUnit: "lb",
    weightError: "",
    moisture: "",
    testWeight: "",
    isBuffer: false,
  });
}

function logAnotherLoad() {
  clearTruckFields();
  setState({ screen: state.cropChoice ? "crop" : "home" });
}

function changeFieldAndBin() {
  state.field = null;
  state.bin = null;
  state.cropChoice = null;
  clearTruckFields();
  setState({ screen: "crop" });
}

function logOut() {
  // Field/bin stay selected on purpose — the kiosk is shared across
  // workers back-to-back on the same field/bin during a harvest run.
  state.worker = null;
  clearTruckFields();
  setState({ screen: "login", pin: "" });
}

// ---------------------------------------------------------------------
// Auto-logout after 5 minutes of inactivity. Only runs while someone is
// actually logged in — a worker walking away without logging out
// shouldn't leave the kiosk open for the next person to log under their
// name. Any click/tap/key anywhere on the page resets the clock,
// independent of whether that interaction happened to trigger a
// re-render (some inputs mutate state directly without one).
// ---------------------------------------------------------------------
const INACTIVITY_TIMEOUT_MS = typeof globalThis.__GRAINCHAIN_INACTIVITY_MS__ === "number" ? globalThis.__GRAINCHAIN_INACTIVITY_MS__ : 5 * 60 * 1000;
let inactivityTimer = null;

function resetInactivityTimer() {
  if (inactivityTimer) clearTimeout(inactivityTimer);
  inactivityTimer = state.worker ? setTimeout(logOut, INACTIVITY_TIMEOUT_MS) : null;
}

function installInactivityWatcher() {
  ["click", "touchstart", "keydown"].forEach((evt) => document.addEventListener(evt, resetInactivityTimer, { passive: true }));
}

// A way out of the current load from any step, without clicking Back
// through every prior screen. Clears only this load's in-progress
// fields — field/bin/crop stay picked for next time, same as elsewhere.
function cancelLoadButton() {
  return bigButton("Cancel — return to home", {
    onClick: () => {
      clearTruckFields();
      setState({ screen: "home" });
    },
  });
}

// ---------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------

function loginScreen() {
  const wrap = h("div", { style: "display:flex;flex-direction:column;gap:24px;max-width:420px;margin:40px auto 0;" });

  wrap.appendChild(
    h("div", { style: "text-align:center;" }, [
      h("div", { style: `${HEAD}font-size:26px;font-weight:700;color:${COLORS.text};margin-bottom:4px;` }, "Log in to start"),
      h("div", { style: `font-size:14px;color:${COLORS.textMuted};` }, "Enter your PIN"),
    ])
  );

  if (state.workers.length === 0) {
    wrap.appendChild(
      h(
        "div",
        { style: `border:1px dashed ${COLORS.border};border-radius:10px;padding:14px;color:${COLORS.textMuted};font-size:13px;text-align:center;` },
        "No worker roster synced yet — no PIN will be accepted until this Chromebook has connected to the internet at least once."
      )
    );
  }

  const input = h("input", {
    inputmode: "numeric",
    placeholder: "Enter PIN",
    value: state.pin,
    style: `${BODY}font-size:20px;letter-spacing:4px;text-align:center;padding:14px;border-radius:8px;border:1px solid ${COLORS.border};background:${COLORS.panel};color:${COLORS.text};`,
    oninput: (e) => {
      state.pin = e.target.value.replace(/\D/g, "");
      state.pinError = "";
    },
  });

  const submit = () => {
    const match = state.workers.find((w) => w.pin === state.pin && w.active !== false);
    if (!match) {
      setState({ pinError: "PIN not recognized. Try again." });
      return;
    }
    setState({ worker: match, pin: "", pinError: "", screen: "home" });
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });

  const col = h("div", { style: "display:flex;flex-direction:column;gap:8px;" }, [
    input,
    state.pinError ? h("div", { style: `font-size:13px;color:${COLORS.danger};` }, state.pinError) : null,
    h(
      "button",
      {
        style: `${BODY}font-size:16px;font-weight:700;padding:14px;border-radius:8px;border:1px solid ${COLORS.gold};background:${COLORS.goldDark};color:${COLORS.gold};cursor:pointer;`,
        onclick: submit,
      },
      "Log in"
    ),
  ]);
  wrap.appendChild(col);
  return wrap;
}

function homeScreen() {
  const wrap = h("div", { style: "display:flex;flex-direction:column;gap:14px;" });
  wrap.appendChild(h("div", { style: `${HEAD}font-size:24px;font-weight:700;color:${COLORS.text};` }, "What are you logging?"));

  if (state.cropChoice && state.field && state.bin) {
    wrap.appendChild(
      bigButton(`${state.field.name} → ${state.bin.name}`, {
        tone: "gold",
        sub: `Same as last load — ${state.cropChoice} — straight to truck`,
        onClick: () => setState({ screen: "truck" }),
      })
    );
  }

  wrap.appendChild(
    bigButton("Field delivery", {
      tone: state.cropChoice && state.field && state.bin ? "default" : "gold",
      sub: "Pit → wet bin, at the home site",
      onClick: () => setState({ screen: "crop" }),
    })
  );
  wrap.appendChild(bigButton("Elevator delivery (Danube / Fairfax)", { disabled: true, sub: "Coming in a later phase" }));
  wrap.appendChild(bigButton("View bin levels", { disabled: true, sub: "Coming in a later phase" }));
  const dryersRunning = Object.values(state.dryerActive).filter(Boolean).length;
  wrap.appendChild(
    bigButton("Dryer operator", {
      sub: dryersRunning > 0 ? `${dryersRunning} dryer${dryersRunning === 1 ? "" : "s"} running` : "Start a run, log readings, confirm grain status",
      onClick: () => setState({ screen: "dryerHome" }),
    })
  );
  wrap.appendChild(h("div", { style: "margin-top:8px;" }, [linkButton("Log out", logOut)]));
  return wrap;
}

function cropScreen() {
  const wrap = h("div", { style: "display:flex;flex-direction:column;gap:14px;" });
  wrap.appendChild(h("div", { style: `${HEAD}font-size:22px;font-weight:700;color:${COLORS.text};` }, "Which crop?"));
  wrap.appendChild(
    h("div", { style: `font-size:13px;color:${COLORS.textMuted};margin-top:-8px;` }, "This narrows the field list to just that crop.")
  );
  CROPS.forEach((crop) => {
    wrap.appendChild(
      bigButton(crop, {
        tone: crop === state.cropChoice ? "gold" : "default",
        sub: crop === state.cropChoice ? "Same as last load" : undefined,
        onClick: () => {
          state.cropChoice = crop;
          state.statusFilter = "All"; // keep whatever field/crop was last used visible, not hidden by a leftover filter
          setState({ screen: "field" });
        },
      })
    );
  });
  wrap.appendChild(linkButton("← Back", () => setState({ screen: "home" })));
  wrap.appendChild(cancelLoadButton());
  return wrap;
}

function fieldScreen() {
  const wrap = h("div", { style: "display:flex;flex-direction:column;gap:14px;" });
  wrap.appendChild(
    h("div", { style: "display:flex;align-items:center;gap:10px;" }, [
      h("div", { style: `${HEAD}font-size:22px;font-weight:700;color:${COLORS.text};` }, "Which field?"),
      h("span", { style: `${BODY}font-size:12px;font-weight:700;color:${COLORS.gold};background:${COLORS.goldDark};padding:4px 10px;border-radius:999px;` }, state.cropChoice),
    ])
  );
  wrap.appendChild(
    h("div", { style: `font-size:13px;color:${COLORS.textMuted};margin-top:-8px;` }, "Organic status is pulled from your field records — no need to enter it.")
  );

  const cropFields = state.fields.filter((f) => f.crop === state.cropChoice);

  if (state.fields.length === 0) {
    wrap.appendChild(
      h(
        "div",
        { style: `border:1px dashed ${COLORS.border};border-radius:10px;padding:20px;color:${COLORS.textMuted};font-size:13px;text-align:center;` },
        "No fields synced yet. Make sure this Chromebook has connected to the internet at least once since setup."
      )
    );
  } else if (cropFields.length === 0) {
    wrap.appendChild(
      h(
        "div",
        { style: `border:1px dashed ${COLORS.border};border-radius:10px;padding:20px;color:${COLORS.textMuted};font-size:13px;text-align:center;` },
        `No fields are marked as ${state.cropChoice} yet — crop isn't populated on field records yet, ask the office to confirm.`
      )
    );
  } else {
    const tabs = h(
      "div",
      { style: "display:flex;gap:8px;" },
      [
        { key: "All", label: "All" },
        { key: "organic", label: "Organic" },
        { key: "transitional", label: "Transitional" },
        { key: "conventional", label: "Conventional" },
      ].map((c) =>
        h(
          "button",
          {
            style: `${BODY}flex:1;padding:10px 6px;border-radius:8px;border:1px solid ${state.statusFilter === c.key ? COLORS.gold : COLORS.border};background:${state.statusFilter === c.key ? COLORS.goldDark : COLORS.panelAlt};color:${state.statusFilter === c.key ? COLORS.gold : COLORS.text};font-size:13px;font-weight:600;cursor:pointer;`,
            onclick: () => setState({ statusFilter: c.key }),
          },
          c.label
        )
      )
    );
    wrap.appendChild(tabs);

    const list = h("div", { style: "display:flex;flex-direction:column;gap:10px;max-height:420px;overflow-y:auto;padding-right:4px;" });
    cropFields
      .filter((f) => state.statusFilter === "All" || f.status === state.statusFilter)
      .forEach((f) => {
        const selected = state.field && state.field.id === f.id;
        list.appendChild(
          h(
            "button",
            {
              style: `${BODY}display:flex;align-items:center;justify-content:space-between;padding:16px 18px;border-radius:10px;border:1px solid ${selected ? COLORS.gold : COLORS.border};background:${selected ? COLORS.goldDark : COLORS.panelAlt};color:${selected ? COLORS.gold : COLORS.text};cursor:pointer;text-align:left;`,
              "data-selected": selected ? "true" : null,
              onclick: () => {
                state.field = f;
                setState({ screen: "truck" });
              },
            },
            [
              h("div", {}, [
                h("div", { style: "font-size:16px;font-weight:600;" }, f.name),
                h("div", { style: `font-size:13px;color:${selected ? COLORS.gold : COLORS.textMuted};` }, selected ? "Same as last load" : f.acres ? `${f.acres} ac` : "Acreage on file"),
              ]),
              badge(f.status),
            ]
          )
        );
      });
    wrap.appendChild(list);
  }

  wrap.appendChild(linkButton("← Back", () => setState({ screen: "crop" })));
  wrap.appendChild(cancelLoadButton());
  return wrap;
}

function truckScreen() {
  const wrap = h("div", { style: "display:flex;flex-direction:column;gap:14px;" });
  wrap.appendChild(h("div", { style: `${HEAD}font-size:22px;font-weight:700;color:${COLORS.text};` }, "Truck and load"));
  wrap.appendChild(
    h(
      "div",
      { style: `font-size:13px;color:${COLORS.textMuted};margin-top:-8px;` },
      "Every truck is assumed full — bushels are pre-calculated automatically. Flag it below if that's not the case."
    )
  );

  wrap.appendChild(h("div", { style: `font-size:13px;color:${COLORS.textMuted};margin-bottom:-4px;` }, "Truck / trailer"));
  const grid = h("div", { style: "display:grid;grid-template-columns:repeat(4,1fr);gap:8px;" });
  TRUCKS.forEach((t) => {
    const selected = state.truckMode !== "buffer" && state.truck === t;
    grid.appendChild(
      h(
        "button",
        {
          style: `${BODY}padding:16px 8px;border-radius:10px;border:1px solid ${selected ? COLORS.gold : COLORS.border};background:${selected ? COLORS.goldDark : COLORS.panelAlt};color:${selected ? COLORS.gold : COLORS.text};font-size:16px;font-weight:700;cursor:pointer;text-align:center;`,
          onclick: () => {
            state.truck = t;
            state.truckMode = state.truckMode === "buffer" || !state.truckMode ? "full" : state.truckMode;
            setState({ weightError: "" });
          },
        },
        t
      )
    );
  });
  wrap.appendChild(grid);

  if (state.truck && state.truckMode !== "buffer") {
    wrap.appendChild(
      h("div", { style: `font-size:13px;color:${COLORS.textMuted};` }, [
        `Truck ${state.truck} pre-calculated load: `,
        h("span", { style: `color:${COLORS.text};font-weight:600;` }, `${TRUCK_BUSHELS[state.truck].toLocaleString()} bu (full)`),
      ])
    );
  }

  wrap.appendChild(
    h(
      "button",
      {
        style: `${BODY}padding:14px 16px;border-radius:10px;border:1px solid ${state.truckMode === "buffer" ? COLORS.amber : COLORS.amberDark};background:${COLORS.amberDark};color:${COLORS.amber};font-size:15px;font-weight:700;cursor:pointer;text-align:center;`,
        onclick: () => {
          state.truckMode = "buffer";
          state.truck = null;
          state.isBuffer = true;
          setState({ weightError: "" });
        },
      },
      "Buffer truck"
    )
  );

  wrap.appendChild(
    h(
      "button",
      {
        style: `${BODY}padding:14px 16px;border-radius:10px;border:1px solid ${state.truckMode === "notFull" ? COLORS.gold : COLORS.border};background:${state.truckMode === "notFull" ? COLORS.goldDark : COLORS.panelAlt};color:${state.truckMode === "notFull" ? COLORS.gold : COLORS.text};font-size:15px;font-weight:700;cursor:${state.truck ? "pointer" : "not-allowed"};opacity:${state.truck ? 1 : 0.4};text-align:center;`,
        disabled: !state.truck,
        onclick: () => {
          state.truckMode = state.truckMode === "notFull" ? "full" : "notFull";
          state.isBuffer = false;
          setState({ weightError: "" });
        },
      },
      "Truck not full"
    )
  );

  if (state.truckMode === "buffer" || state.truckMode === "notFull") {
    wrap.appendChild(h("div", { style: `font-size:13px;color:${COLORS.textMuted};margin-top:4px;margin-bottom:-4px;` }, "Enter as weight or bushels — whichever the cart driver gave you"));
    wrap.appendChild(
      h("div", { style: "display:flex;gap:8px;" }, [
        h(
          "button",
          {
            style: `${BODY}flex:1;padding:10px;border-radius:8px;border:1px solid ${state.weightUnit === "lb" ? COLORS.gold : COLORS.border};background:${state.weightUnit === "lb" ? COLORS.goldDark : COLORS.panelAlt};color:${state.weightUnit === "lb" ? COLORS.gold : COLORS.text};font-size:14px;font-weight:600;cursor:pointer;`,
            onclick: () => setState({ weightUnit: "lb", weightError: "" }),
          },
          "Weight (lb)"
        ),
        h(
          "button",
          {
            style: `${BODY}flex:1;padding:10px;border-radius:8px;border:1px solid ${state.weightUnit === "bu" ? COLORS.gold : COLORS.border};background:${state.weightUnit === "bu" ? COLORS.goldDark : COLORS.panelAlt};color:${state.weightUnit === "bu" ? COLORS.gold : COLORS.text};font-size:14px;font-weight:600;cursor:pointer;`,
            onclick: () => setState({ weightUnit: "bu", weightError: "" }),
          },
          "Bushels"
        ),
      ])
    );
    wrap.appendChild(
      h("input", {
        inputmode: "decimal",
        placeholder: state.weightUnit === "bu" ? "e.g. 950" : "e.g. 62,400",
        value: state.weight,
        style: `${BODY}font-size:20px;padding:14px;border-radius:8px;border:1px solid ${COLORS.border};background:${COLORS.panel};color:${COLORS.text};`,
        oninput: (e) => {
          state.weight = e.target.value.replace(/[^0-9.]/g, "");
          state.weightError = "";
        },
      })
    );
    wrap.appendChild(
      h(
        "div",
        { style: `font-size:12px;color:${COLORS.textMuted};` },
        "Driver-reported reading, not a certified scale ticket — flagged as estimated unless this load is later weighed at Danube or Fairfax."
      )
    );
  }

  if (state.weightError) {
    wrap.appendChild(h("div", { style: `font-size:13px;color:${COLORS.danger};` }, state.weightError));
  }

  const optWrap = h("div", { style: `border-top:1px solid ${COLORS.border};padding-top:14px;display:flex;flex-direction:column;gap:10px;` });
  optWrap.appendChild(h("div", { style: `font-size:13px;color:${COLORS.textMuted};` }, "Optional — moisture and test weight"));
  const optRow = h("div", { style: "display:flex;gap:10px;" }, [
    h("input", {
      inputmode: "decimal",
      placeholder: "Moisture %",
      value: state.moisture,
      style: `${BODY}flex:1;font-size:15px;padding:12px;border-radius:8px;border:1px solid ${COLORS.border};background:${COLORS.panel};color:${COLORS.text};`,
      oninput: (e) => (state.moisture = e.target.value.replace(/[^0-9.]/g, "")),
    }),
    h("input", {
      inputmode: "decimal",
      placeholder: "Test weight lb/bu",
      value: state.testWeight,
      style: `${BODY}flex:1;font-size:15px;padding:12px;border-radius:8px;border:1px solid ${COLORS.border};background:${COLORS.panel};color:${COLORS.text};`,
      oninput: (e) => (state.testWeight = e.target.value.replace(/[^0-9.]/g, "")),
    }),
  ]);
  optWrap.appendChild(optRow);
  wrap.appendChild(optWrap);

  wrap.appendChild(
    bigButton("Continue", {
      tone: "gold",
      onClick: () => {
        if (state.truckMode !== "buffer" && !state.truck) {
          setState({ weightError: "Select which truck first." });
          return;
        }
        const needsWeight = state.truckMode === "buffer" || state.truckMode === "notFull";
        if (needsWeight) {
          const w = parseFloat(state.weight);
          if (!state.weight || isNaN(w) || w <= 0) {
            setState({ weightError: "Enter the weight or bushels the cart driver gave you." });
            return;
          }
        }
        setState({ weightError: "", screen: "bin" });
      },
    })
  );
  wrap.appendChild(linkButton("← Back", () => setState({ screen: "field" })));
  wrap.appendChild(cancelLoadButton());
  return wrap;
}

function binScreen() {
  if (!state.field) {
    setState({ screen: "field" });
    return h("div");
  }
  const wrap = h("div", { style: "display:flex;flex-direction:column;gap:14px;" });
  wrap.appendChild(
    h("div", { style: "display:flex;align-items:center;gap:10px;" }, [
      h("div", { style: `${HEAD}font-size:22px;font-weight:700;color:${COLORS.text};` }, "Which bin?"),
      badge(state.isBuffer ? "conventional" : state.field.status),
    ])
  );

  const bufferLabel = h(
    "label",
    {
      style: `display:flex;align-items:center;gap:10px;font-size:14px;color:${COLORS.text};background:${COLORS.panelAlt};border:1px solid ${COLORS.border};border-radius:8px;padding:10px 14px;cursor:pointer;`,
    },
    [
      h("input", {
        type: "checkbox",
        checked: state.isBuffer,
        onchange: (e) => setState({ isBuffer: e.target.checked }),
      }),
      "This load is buffer grain (must sell conventional)",
    ]
  );
  wrap.appendChild(bufferLabel);
  wrap.appendChild(h("div", { style: `font-size:13px;color:${COLORS.textMuted};margin-top:-4px;` }, "Bins that can't take this load are grayed out and explain why."));

  // Field delivery is specifically the home-site pit → wet bin flow, so
  // only home-site storage/wet bins belong here — not Danube/Fairfax/other
  // satellite sites, and not loadout or not-yet-built bins.
  const homeBins = state.bins.filter((b) => b.site === "HOME" && (b.bin_type === "storage" || b.bin_type === "wet") && b.active !== false);

  if (homeBins.length === 0) {
    wrap.appendChild(
      h(
        "div",
        { style: `border:1px dashed ${COLORS.border};border-radius:10px;padding:20px;color:${COLORS.textMuted};font-size:13px;text-align:center;` },
        "No home-site bins synced yet. Make sure this Chromebook has connected to the internet at least once since setup."
      )
    );
  } else {
    const effectiveStatus = state.isBuffer ? "conventional" : state.field.status;
    const list = h("div", { style: "display:flex;flex-direction:column;gap:10px;" });
    homeBins.forEach((b) => {
      // Wet/staging bins (A, B, H-10) are transient — grain passes through
      // to the dryer or on to another bin, so they take any status and any
      // crop.
      const isWetStaging = b.bin_type === "wet";
      const statusOk =
        isWetStaging ||
        (effectiveStatus === "organic"
          ? b.status === "organic" && b.affidavit
          : effectiveStatus === "transitional"
          ? b.status === "transitional" || b.status === "conventional"
          : b.status !== "organic");
      const cropOk = isWetStaging || !b.crop || b.crop === state.cropChoice;
      const compatible = statusOk && cropOk;
      const reason = !statusOk
        ? effectiveStatus === "organic" && b.status === "organic" && !b.affidavit
          ? "Needs a clean bin affidavit before organic use"
          : effectiveStatus === "organic" && b.status !== "organic"
          ? "Not an organic bin"
          : effectiveStatus !== "organic" && b.status === "organic"
          ? "Reserved for organic grain"
          : ""
        : !cropOk
        ? `Reserved for ${b.crop}`
        : "";
      const selected = compatible && state.bin && state.bin.id === b.id;
      list.appendChild(
        h(
          "button",
          {
            style: `${BODY}display:flex;align-items:center;justify-content:space-between;padding:16px 18px;border-radius:10px;border:1px solid ${!compatible ? COLORS.dangerDark : selected ? COLORS.gold : COLORS.border};background:${!compatible ? COLORS.dangerDark : selected ? COLORS.goldDark : COLORS.panelAlt};color:${!compatible ? COLORS.danger : selected ? COLORS.gold : COLORS.text};cursor:${compatible ? "pointer" : "not-allowed"};opacity:${compatible ? 1 : 0.75};text-align:left;`,
            disabled: !compatible,
            "data-selected": selected ? "true" : null,
            onclick: compatible
              ? () => {
                  state.bin = b;
                  setState({ screen: "confirm" });
                }
              : null,
          },
          [
            h("div", {}, [
              h("div", { style: "font-size:16px;font-weight:600;" }, b.name),
              h(
                "div",
                { style: `font-size:13px;color:${!compatible ? COLORS.danger : selected ? COLORS.gold : COLORS.textMuted};` },
                !compatible ? reason : selected ? "Same as last load" : `${b.pct}% full`
              ),
            ]),
            isWetStaging
              ? h(
                  "span",
                  { style: `${BODY}font-size:12px;font-weight:700;color:${COLORS.amber};background:${COLORS.amberDark};padding:4px 10px;border-radius:999px;white-space:nowrap;` },
                  "Wet / staging"
                )
              : compatible
              ? badge(b.status)
              : null,
          ]
        )
      );
    });
    wrap.appendChild(list);
  }

  wrap.appendChild(linkButton("← Back", () => setState({ screen: "truck" })));
  wrap.appendChild(cancelLoadButton());
  return wrap;
}

function confirmScreen() {
  const { field, bin, worker, truck, truckMode, weight, weightUnit, moisture, testWeight, isBuffer } = state;
  const wrap = h("div", { style: "display:flex;flex-direction:column;gap:16px;" });
  wrap.appendChild(h("div", { style: `${HEAD}font-size:22px;font-weight:700;color:${COLORS.text};` }, "Confirm load"));

  const rows = [
    ["Worker", worker.name],
    ["Crop", state.cropChoice],
    ["Field", field.name],
    ["Acres", field.acres ? `${field.acres}` : "On file"],
    ["Status", null],
    ["Truck", truckMode === "buffer" ? "Buffer truck" : `Truck ${truck}${truckMode === "notFull" ? " (not full)" : " (full)"}`],
    [
      "Load",
      truckMode === "buffer" || truckMode === "notFull"
        ? `${Number(weight).toLocaleString()} ${weightUnit === "bu" ? "bu" : "lb"} (estimated)`
        : `${TRUCK_BUSHELS[truck].toLocaleString()} bu (pre-calculated, full)`,
    ],
    ...(moisture ? [["Moisture", `${moisture}%`]] : []),
    ...(testWeight ? [["Test weight", `${testWeight} lb/bu`]] : []),
    ["Destination bin", bin.name],
  ];

  const card = h("div", {
    style: `background:${COLORS.panelAlt};border:1px solid ${COLORS.border};border-radius:10px;padding:18px 20px;display:flex;flex-direction:column;gap:12px;`,
  });
  rows.forEach(([label, val]) => {
    card.appendChild(
      h("div", { style: "display:flex;justify-content:space-between;align-items:center;gap:12px;" }, [
        h("span", { style: `font-size:13px;color:${COLORS.textMuted};` }, label),
        label === "Status" ? badge(isBuffer ? "conventional" : field.status) : h("span", { style: `font-size:14px;color:${COLORS.text};text-align:right;` }, val),
      ])
    );
  });
  wrap.appendChild(card);

  wrap.appendChild(
    bigButton("Log this load", {
      tone: "gold",
      onClick: submitLoad,
    })
  );
  wrap.appendChild(linkButton("← Back", () => setState({ screen: "bin" })));
  wrap.appendChild(cancelLoadButton());
  return wrap;
}

function successScreen() {
  const { field, bin, worker } = state;
  const wrap = h("div", { style: "display:flex;flex-direction:column;align-items:center;gap:16px;margin-top:20px;" });
  wrap.appendChild(
    h(
      "div",
      {
        style: `width:64px;height:64px;border-radius:50%;background:${COLORS.organicDark};color:${COLORS.organic};display:flex;align-items:center;justify-content:center;font-size:28px;`,
      },
      "✓"
    )
  );
  wrap.appendChild(h("div", { style: `${HEAD}font-size:22px;font-weight:700;color:${COLORS.text};` }, "Load logged"));
  wrap.appendChild(h("div", { style: `font-size:14px;color:${COLORS.textMuted};text-align:center;` }, `${field.name} → ${bin.name}, ${worker.name}`));
  wrap.appendChild(
    h("div", { style: "display:flex;gap:10px;width:100%;max-width:360px;" }, [
      bigButton("Log another load", { tone: "gold", sub: "Next truck, same field and bin", onClick: logAnotherLoad }),
    ])
  );
  wrap.appendChild(linkButton("Different field or bin", changeFieldAndBin, COLORS.gold));
  wrap.appendChild(linkButton("Log out", logOut));
  return wrap;
}

async function submitLoad() {
  const { worker, field, bin, truck, truckMode, weight, weightUnit, moisture, testWeight, isBuffer, cropChoice } = state;
  const isPartial = truckMode === "buffer" || truckMode === "notFull";
  await queueLoad({
    workerId: worker.id,
    fieldId: field.id,
    crop: cropChoice,
    truck: truckMode === "buffer" ? null : truck,
    truckMode,
    bushels: truckMode === "full" ? TRUCK_BUSHELS[truck] : isPartial && weightUnit === "bu" ? Number(weight) : null,
    weightLb: isPartial && weightUnit === "lb" ? Number(weight) : null,
    moisturePct: moisture ? Number(moisture) : null,
    testWeight: testWeight ? Number(testWeight) : null,
    binId: bin.id,
    isBuffer,
  });
  await refreshTodayLog();
  setState({ screen: "success" });
}

// ---------------------------------------------------------------------
// Shell: top bar, step dots, log panel, master render()
// ---------------------------------------------------------------------

function topBar() {
  const bar = h("div", {
    style: `${BODY}display:flex;align-items:center;justify-content:space-between;padding:14px 28px;border-bottom:1px solid ${COLORS.border};background:${COLORS.panel};`,
  });
  bar.appendChild(
    h("div", { style: "display:flex;align-items:baseline;gap:10px;" }, [
      h("span", { style: `${HEAD}font-size:20px;font-weight:700;color:${COLORS.gold};letter-spacing:0.5px;` }, "GRAINCHAIN"),
      h("span", { style: `font-size:13px;color:${COLORS.textMuted};` }, "Home Site"),
    ])
  );
  const right = h("div", { style: "display:flex;align-items:center;gap:20px;" });
  if (state.worker) {
    right.appendChild(
      h("div", { style: "display:flex;align-items:center;gap:8px;" }, [
        h(
          "div",
          {
            style: `width:30px;height:30px;border-radius:50%;background:${COLORS.goldDark};color:${COLORS.gold};display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;`,
          },
          state.worker.name
            .split(" ")
            .map((n) => n[0])
            .join("")
        ),
        h("span", { style: `font-size:14px;color:${COLORS.text};` }, state.worker.name),
      ])
    );
  }
  bar.appendChild(right);
  return bar;
}

// ---------------------------------------------------------------------
// Dryer operator — wet bin -> dryer -> dry bin. A run only ever becomes a
// real dryer_runs record once it's stopped; while running, its state
// lives in state.dryerActive (restored from IndexedDB on mount, so it
// survives a reload on this device) and its readings sync independently
// as they're logged. See add-dryer-batches.sql for the full reasoning.
// ---------------------------------------------------------------------

const DRYER_NAMES = ["Tower Dryer", "Super B"];
const DRYER_CROPS = ["Corn", "Oats"]; // dryer flow only — the field-delivery CROPS list above is unrelated and unchanged
const SUPER_B_SOURCE_BIN_ID = "HOME-10"; // Super B only ever draws from bin 10 — no picker, hardcoded

function numField(label, placeholder, getValue, setValue) {
  const wrap = h("div", { style: "display:flex;flex-direction:column;gap:4px;" });
  if (label) wrap.appendChild(h("div", { style: `font-size:13px;color:${COLORS.textMuted};` }, label));
  wrap.appendChild(
    h("input", {
      inputmode: "decimal",
      placeholder,
      value: getValue(),
      style: `${BODY}font-size:18px;padding:12px;border-radius:8px;border:1px solid ${COLORS.border};background:${COLORS.panel};color:${COLORS.text};`,
      // Mutates state directly without calling render() — same pattern as
      // the weight field in truckScreen above. Re-rendering on every
      // keystroke would rebuild the input and lose focus.
      oninput: (e) => setValue(e.target.value.replace(/[^0-9.]/g, "")),
    })
  );
  return wrap;
}

// discharge_rate on the sheet is a 0-100 dial setting, not bu/hr — see
// add-dryer-batches.sql for the calibration table these factors come
// from (both exactly linear, confirmed against the operators' own
// output tables). Keep these in sync with the SQL view's CASE values.
export const DRYER_RATE_FACTOR = { "Tower Dryer": 24.8, "Super B": 25.0 };

// Mirrors dryer_run_estimates in add-dryer-batches.sql exactly — a STEP
// function: each reading's rate holds steady until the NEXT reading (or
// until endTime, for the last one), not an average between neighbors.
// endTime is "now" for a live in-progress estimate, or the run's actual
// ended_at once it's been stopped.
export function estimateBushelsFromReadings(readings, endTime) {
  const sorted = [...readings].sort((a, b) => new Date(a.recordedAt) - new Date(b.recordedAt));
  const end = new Date(endTime);
  let total = 0;
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    const segmentEnd = i < sorted.length - 1 ? new Date(sorted[i + 1].recordedAt) : end;
    const factor = DRYER_RATE_FACTOR[r.dryerName] || 0;
    const rate = r.dischargeRate != null && r.dischargeRate !== "" ? Number(r.dischargeRate) * factor : 0;
    const hours = (segmentEnd - new Date(r.recordedAt)) / 3600000;
    if (hours > 0) total += rate * hours;
  }
  return Math.round(total);
}

function elapsedLabel(startedAt) {
  const ms = Date.now() - new Date(startedAt).getTime();
  const hrs = Math.floor(ms / 3600000);
  const mins = Math.round((ms % 3600000) / 60000);
  return `${hrs}h ${mins}m`;
}

function dryerHomeScreen() {
  const wrap = h("div", { style: "display:flex;flex-direction:column;gap:14px;" });
  wrap.appendChild(h("div", { style: `${HEAD}font-size:22px;font-weight:700;color:${COLORS.text};` }, "Dryer operator"));

  DRYER_NAMES.forEach((dryerName) => {
    const active = state.dryerActive[dryerName];
    const card = h("div", {
      style: `background:${COLORS.panelAlt};border:1px solid ${active ? COLORS.gold : COLORS.border};border-radius:10px;padding:16px 18px;display:flex;flex-direction:column;gap:10px;`,
    });
    card.appendChild(h("div", { style: `${HEAD}font-size:17px;font-weight:700;color:${COLORS.text};` }, dryerName));

    if (!active) {
      card.appendChild(h("div", { style: `font-size:13px;color:${COLORS.textMuted};` }, "Idle"));
      card.appendChild(
        bigButton("Start run", {
          tone: "gold",
          onClick: () => {
            state.dryerCurrent = dryerName;
            state.dryerStartForm = {
              // Super B only ever draws from bin 10 — hardcoded, no picker.
              sourceBinId: dryerName === "Super B" ? SUPER_B_SOURCE_BIN_ID : "",
              destBinId: "",
              crop: "",
              status: "",
              wetPctIn: "",
              dryPctOut: "",
              dryTemp: "",
              midgrainTemp: "",
              dischargeRate: "",
              plenumTemp: "",
              notes: "",
            };
            setState({ screen: "dryerStart", dryerFormError: "" });
          },
        })
      );
    } else {
      const destBin = state.bins.find((b) => b.id === active.destBinId);
      const sourceBin = state.bins.find((b) => b.id === active.sourceBinId);
      const readingsForThisRun = state.dryerReadings.filter((r) => r.runClientId === active.runClientId);
      const estimate = estimateBushelsFromReadings(readingsForThisRun, new Date());
      card.appendChild(
        h("div", { style: "display:flex;align-items:center;gap:8px;flex-wrap:wrap;" }, [
          badge(active.status),
          h("span", { style: `font-size:13px;color:${COLORS.text};` }, `${active.crop} — ${sourceBin ? sourceBin.name : active.sourceBinId || "—"} → ${destBin ? destBin.name : active.destBinId}`),
        ])
      );
      card.appendChild(
        h(
          "div",
          { style: `font-size:13px;color:${COLORS.textMuted};` },
          `Running ${elapsedLabel(active.startedAt)} — est. ${estimate.toLocaleString()} bu so far (${readingsForThisRun.length} reading${readingsForThisRun.length === 1 ? "" : "s"})`
        )
      );
      card.appendChild(
        h("div", { style: "display:flex;gap:8px;" }, [
          h("div", { style: "flex:1;" }, [
            bigButton("Log reading", {
              tone: "gold",
              onClick: () => {
                state.dryerCurrent = dryerName;
                // Discharge rate defaults to this run's own most recent
                // entry — the operator is usually confirming "still the
                // same" rather than retyping it fresh every check.
                const priorReadings = state.dryerReadings.filter((rd) => rd.runClientId === active.runClientId).sort((a, b) => new Date(b.recordedAt) - new Date(a.recordedAt));
                const lastRate = priorReadings[0]?.dischargeRate;
                state.dryerReadingForm = {
                  wetPctIn: "",
                  dryPctOut: "",
                  dryTemp: "",
                  midgrainTemp: "",
                  dischargeRate: lastRate != null ? String(lastRate) : "",
                  plenumTemp: "",
                  notes: "",
                };
                setState({ screen: "dryerReading", dryerFormError: "" });
              },
            }),
          ]),
          h("div", { style: "flex:1;" }, [
            bigButton("Stop run", {
              onClick: () => {
                state.dryerCurrent = dryerName;
                state.dryerStopForm = { actualBushels: "", notes: "" };
                setState({ screen: "dryerStop" });
              },
            }),
          ]),
        ])
      );
    }
    wrap.appendChild(card);
  });

  wrap.appendChild(linkButton("← Back", () => setState({ screen: "home" })));
  return wrap;
}

function dryerStartScreen() {
  const wrap = h("div", { style: "display:flex;flex-direction:column;gap:14px;" });
  wrap.appendChild(h("div", { style: `${HEAD}font-size:22px;font-weight:700;color:${COLORS.text};` }, `Start run — ${state.dryerCurrent}`));
  const f = state.dryerStartForm;

  if (state.dryerCurrent === "Super B") {
    // Super B only ever draws from bin 10 — no picker; sourceBinId was
    // already hardcoded to it the moment "Start run" was tapped.
    wrap.appendChild(h("div", { style: `font-size:13px;color:${COLORS.textMuted};` }, `From: Bin 10 (fixed — Super B always draws from here)`));
  } else {
    wrap.appendChild(h("div", { style: `font-size:13px;color:${COLORS.textMuted};margin-bottom:-4px;` }, "From (wet bin)"));
    const wetBins = state.bins.filter((b) => b.bin_type === "wet" && b.active !== false);
    const sourceGrid = h("div", { style: "display:grid;grid-template-columns:repeat(3,1fr);gap:8px;" });
    wetBins.forEach((b) => {
      const selected = f.sourceBinId === b.id;
      sourceGrid.appendChild(
        h(
          "button",
          {
            style: `${BODY}padding:14px 8px;border-radius:10px;border:1px solid ${selected ? COLORS.gold : COLORS.border};background:${selected ? COLORS.goldDark : COLORS.panelAlt};color:${selected ? COLORS.gold : COLORS.text};font-size:15px;font-weight:700;cursor:pointer;text-align:center;`,
            onclick: () => setState({ dryerStartForm: { ...f, sourceBinId: b.id } }),
          },
          b.name
        )
      );
    });
    wrap.appendChild(sourceGrid);
  }

  wrap.appendChild(h("div", { style: `font-size:13px;color:${COLORS.textMuted};margin-bottom:-4px;` }, "To (dry bin)"));
  // Home farm bins only, plus Reclaim Bin — see add-reclaim-bin.sql.
  const dryBins = state.bins.filter((b) => b.bin_type !== "wet" && b.site === "HOME" && b.active !== false);
  const destGrid = h("div", { style: "display:grid;grid-template-columns:repeat(3,1fr);gap:8px;max-height:220px;overflow-y:auto;" });
  dryBins.forEach((b) => {
    const selected = f.destBinId === b.id;
    destGrid.appendChild(
      h(
        "button",
        {
          style: `${BODY}padding:14px 8px;border-radius:10px;border:1px solid ${selected ? COLORS.gold : COLORS.border};background:${selected ? COLORS.goldDark : COLORS.panelAlt};color:${selected ? COLORS.gold : COLORS.text};font-size:15px;font-weight:700;cursor:pointer;text-align:center;`,
          onclick: () => setState({ dryerStartForm: { ...f, destBinId: b.id } }),
        },
        b.name
      )
    );
  });
  wrap.appendChild(destGrid);

  wrap.appendChild(h("div", { style: `font-size:13px;color:${COLORS.textMuted};margin-bottom:-4px;` }, "Crop"));
  const cropRow = h("div", { style: "display:flex;gap:8px;" });
  DRYER_CROPS.forEach((crop) => {
    cropRow.appendChild(
      h(
        "button",
        {
          style: `${BODY}flex:1;padding:12px;border-radius:8px;border:1px solid ${f.crop === crop ? COLORS.gold : COLORS.border};background:${f.crop === crop ? COLORS.goldDark : COLORS.panelAlt};color:${f.crop === crop ? COLORS.gold : COLORS.text};font-size:14px;font-weight:600;cursor:pointer;`,
          onclick: () => setState({ dryerStartForm: { ...f, crop } }),
        },
        crop
      )
    );
  });
  wrap.appendChild(cropRow);

  wrap.appendChild(h("div", { style: `font-size:13px;color:${COLORS.textMuted};margin-bottom:-4px;` }, "Status — confirm what's actually running right now, not what this bin will be used for later"));
  const statusRow = h("div", { style: "display:flex;gap:8px;" });
  ["organic", "transitional", "conventional"].forEach((status) => {
    const s = STATUS_LABEL[status];
    statusRow.appendChild(
      h(
        "button",
        {
          style: `${BODY}flex:1;padding:12px;border-radius:8px;border:1px solid ${f.status === status ? s.fg : COLORS.border};background:${f.status === status ? s.bg : COLORS.panelAlt};color:${f.status === status ? s.fg : COLORS.text};font-size:14px;font-weight:600;cursor:pointer;`,
          onclick: () => setState({ dryerStartForm: { ...f, status } }),
        },
        s.label
      )
    );
  });
  wrap.appendChild(statusRow);

  wrap.appendChild(h("div", { style: `font-size:13px;color:${COLORS.textMuted};margin-top:4px;margin-bottom:-4px;` }, "Current readings, right now — this sets the baseline the run starts from"));
  const grid = h("div", { style: "display:grid;grid-template-columns:1fr 1fr;gap:12px;" });
  grid.appendChild(numField("Wet % incoming", "e.g. 24.5", () => f.wetPctIn, (v) => (f.wetPctIn = v)));
  grid.appendChild(numField("Dry % out", "e.g. 15.0", () => f.dryPctOut, (v) => (f.dryPctOut = v)));
  grid.appendChild(numField("Dry temp", "e.g. 210", () => f.dryTemp, (v) => (f.dryTemp = v)));
  grid.appendChild(numField("Midgrain temp", "e.g. 140", () => f.midgrainTemp, (v) => (f.midgrainTemp = v)));
  grid.appendChild(numField("Discharge rate setting (0–100)", "e.g. 60", () => f.dischargeRate, (v) => (f.dischargeRate = v)));
  grid.appendChild(numField("Plenum temp", "e.g. 230", () => f.plenumTemp, (v) => (f.plenumTemp = v)));
  wrap.appendChild(grid);

  if (state.dryerCurrent === "Super B" && state.dryerActive["Tower Dryer"]) {
    wrap.appendChild(
      h(
        "div",
        { style: `font-size:12px;color:${COLORS.amber};background:${COLORS.amberDark};border-radius:8px;padding:8px 10px;` },
        "Tower Dryer is also running — Super B is limited to a setting of 40 while both run together (dry leg throughput)."
      )
    );
  }

  wrap.appendChild(h("div", { style: `font-size:13px;color:${COLORS.textMuted};margin-bottom:-4px;` }, "Notes"));
  wrap.appendChild(
    h(
      "textarea",
      {
        placeholder: "Optional",
        style: `${BODY}font-size:15px;padding:12px;border-radius:8px;border:1px solid ${COLORS.border};background:${COLORS.panel};color:${COLORS.text};min-height:50px;`,
        oninput: (e) => (f.notes = e.target.value),
      },
      f.notes
    )
  );

  // destBinId/crop/status are all button-driven (setState re-renders
  // live), so disabling on those is safe and responsive. dischargeRate is
  // a text field — see dryerFormError above for why that's validated on
  // submit instead of baked into this disabled state.
  const ready = f.destBinId && f.crop && f.status;
  wrap.appendChild(bigButton("Start run", { tone: "gold", disabled: !ready, onClick: startDryerRun }));
  if (state.dryerFormError) wrap.appendChild(h("div", { style: `font-size:13px;color:${COLORS.danger};` }, state.dryerFormError));
  wrap.appendChild(linkButton("← Back", () => setState({ screen: "dryerHome" })));
  return wrap;
}

async function startDryerRun() {
  const f = state.dryerStartForm;
  if (f.dischargeRate === "" || f.dischargeRate == null) {
    setState({ dryerFormError: "Enter the discharge rate before starting — the bushel estimate is built from it." });
    return;
  }
  state.dryerFormError = "";
  const dryerName = state.dryerCurrent;
  const startedAt = new Date().toISOString();
  const active = {
    runClientId: crypto.randomUUID(),
    sourceBinId: f.sourceBinId || null,
    destBinId: f.destBinId,
    crop: f.crop,
    status: f.status,
    startedAt,
    workerId: state.worker.id,
  };
  await saveActiveDryerRun(dryerName, active);
  // The baseline reading, timestamped to EXACTLY match startedAt — the
  // step-function estimate (see add-dryer-batches.sql) needs a reading
  // right at the run's start, or its first segment has no rate to apply.
  const baselineReading = {
    runClientId: active.runClientId,
    dryerName,
    recordedAt: startedAt,
    wetPctIn: f.wetPctIn ? Number(f.wetPctIn) : null,
    dryPctOut: f.dryPctOut ? Number(f.dryPctOut) : null,
    dryTemp: f.dryTemp ? Number(f.dryTemp) : null,
    midgrainTemp: f.midgrainTemp ? Number(f.midgrainTemp) : null,
    dischargeRate: f.dischargeRate ? Number(f.dischargeRate) : null,
    plenumTemp: f.plenumTemp ? Number(f.plenumTemp) : null,
    notes: f.notes || null,
    workerId: state.worker.id,
  };
  const savedReading = await queueDryerReading(baselineReading);
  state.dryerActive[dryerName] = active;
  state.dryerReadings = [...state.dryerReadings, savedReading];
  setState({ screen: "dryerHome" });
}

function dryerReadingScreen() {
  const dryerName = state.dryerCurrent;
  const active = state.dryerActive[dryerName];
  const wrap = h("div", { style: "display:flex;flex-direction:column;gap:14px;" });
  wrap.appendChild(h("div", { style: `${HEAD}font-size:22px;font-weight:700;color:${COLORS.text};` }, `Log reading — ${dryerName}`));
  if (!active) {
    wrap.appendChild(h("div", { style: `font-size:14px;color:${COLORS.textMuted};` }, "No run in progress."));
    wrap.appendChild(linkButton("← Back", () => setState({ screen: "dryerHome" })));
    return wrap;
  }

  const f = state.dryerReadingForm;
  const grid = h("div", { style: "display:grid;grid-template-columns:1fr 1fr;gap:12px;" });
  grid.appendChild(numField("Wet % incoming", "e.g. 24.5", () => f.wetPctIn, (v) => (f.wetPctIn = v)));
  grid.appendChild(numField("Dry % out", "e.g. 15.0", () => f.dryPctOut, (v) => (f.dryPctOut = v)));
  grid.appendChild(numField("Dry temp", "e.g. 210", () => f.dryTemp, (v) => (f.dryTemp = v)));
  grid.appendChild(numField("Midgrain temp", "e.g. 140", () => f.midgrainTemp, (v) => (f.midgrainTemp = v)));
  grid.appendChild(numField("Discharge rate setting (0–100)", "e.g. 60", () => f.dischargeRate, (v) => (f.dischargeRate = v)));
  grid.appendChild(numField("Plenum temp", "e.g. 230", () => f.plenumTemp, (v) => (f.plenumTemp = v)));
  wrap.appendChild(grid);

  if (dryerName === "Super B" && state.dryerActive["Tower Dryer"]) {
    wrap.appendChild(
      h(
        "div",
        { style: `font-size:12px;color:${COLORS.amber};background:${COLORS.amberDark};border-radius:8px;padding:8px 10px;` },
        "Tower Dryer is also running — Super B is limited to a setting of 40 while both run together (dry leg throughput)."
      )
    );
  }

  wrap.appendChild(h("div", { style: `font-size:13px;color:${COLORS.textMuted};margin-bottom:-4px;` }, "Notes"));
  wrap.appendChild(
    h(
      "textarea",
      {
        placeholder: "Optional",
        style: `${BODY}font-size:15px;padding:12px;border-radius:8px;border:1px solid ${COLORS.border};background:${COLORS.panel};color:${COLORS.text};min-height:60px;`,
        oninput: (e) => (f.notes = e.target.value),
      },
      f.notes
    )
  );

  wrap.appendChild(bigButton("Save reading", { tone: "gold", onClick: saveDryerReading }));
  if (state.dryerFormError) wrap.appendChild(h("div", { style: `font-size:13px;color:${COLORS.danger};` }, state.dryerFormError));

  const readingsForThisRun = state.dryerReadings.filter((r) => r.runClientId === active.runClientId).sort((a, b) => new Date(b.recordedAt) - new Date(a.recordedAt));
  if (readingsForThisRun.length) {
    wrap.appendChild(h("div", { style: `font-size:13px;color:${COLORS.textMuted};margin-top:8px;` }, `Logged this run (${readingsForThisRun.length})`));
    const list = h("div", { style: "display:flex;flex-direction:column;gap:6px;max-height:140px;overflow-y:auto;" });
    readingsForThisRun.forEach((r) => {
      const buPerHour = r.dischargeRate != null ? Math.round(r.dischargeRate * (DRYER_RATE_FACTOR[r.dryerName] || 0)) : null;
      list.appendChild(
        h(
          "div",
          { style: `font-size:12px;color:${COLORS.textMuted};` },
          `${new Date(r.recordedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} — wet ${r.wetPctIn ?? "—"}% / dry ${r.dryPctOut ?? "—"}% / setting ${r.dischargeRate ?? "—"}${buPerHour != null ? ` (≈${buPerHour.toLocaleString()} bu/hr)` : ""}`
        )
      );
    });
    wrap.appendChild(list);
  }

  wrap.appendChild(linkButton("← Back", () => setState({ screen: "dryerHome" })));
  return wrap;
}

async function saveDryerReading() {
  const f = state.dryerReadingForm;
  if (f.dischargeRate === "" || f.dischargeRate == null) {
    setState({ dryerFormError: "Enter the discharge rate before saving — the bushel estimate is built from it." });
    return;
  }
  state.dryerFormError = "";
  const dryerName = state.dryerCurrent;
  const active = state.dryerActive[dryerName];
  const reading = {
    runClientId: active.runClientId,
    dryerName,
    recordedAt: new Date().toISOString(),
    wetPctIn: f.wetPctIn ? Number(f.wetPctIn) : null,
    dryPctOut: f.dryPctOut ? Number(f.dryPctOut) : null,
    dryTemp: f.dryTemp ? Number(f.dryTemp) : null,
    midgrainTemp: f.midgrainTemp ? Number(f.midgrainTemp) : null,
    dischargeRate: f.dischargeRate ? Number(f.dischargeRate) : null,
    plenumTemp: f.plenumTemp ? Number(f.plenumTemp) : null,
    notes: f.notes || null,
    workerId: state.worker.id,
  };
  const saved = await queueDryerReading(reading);
  state.dryerReadings = [...state.dryerReadings, saved];
  setState({ screen: "dryerHome" });
}

function dryerStopScreen() {
  const dryerName = state.dryerCurrent;
  const active = state.dryerActive[dryerName];
  const wrap = h("div", { style: "display:flex;flex-direction:column;gap:14px;" });
  wrap.appendChild(h("div", { style: `${HEAD}font-size:22px;font-weight:700;color:${COLORS.text};` }, `Stop run — ${dryerName}`));
  if (!active) {
    wrap.appendChild(h("div", { style: `font-size:14px;color:${COLORS.textMuted};` }, "No run in progress."));
    wrap.appendChild(linkButton("← Back", () => setState({ screen: "dryerHome" })));
    return wrap;
  }

  const destBin = state.bins.find((b) => b.id === active.destBinId);
  const readingsForThisRun = state.dryerReadings.filter((r) => r.runClientId === active.runClientId);
  const estimate = estimateBushelsFromReadings(readingsForThisRun, new Date());

  const card = h("div", { style: `background:${COLORS.panelAlt};border:1px solid ${COLORS.border};border-radius:10px;padding:16px 18px;display:flex;flex-direction:column;gap:8px;` });
  card.appendChild(h("div", { style: `font-size:14px;color:${COLORS.text};` }, `${active.crop} → ${destBin ? destBin.name : active.destBinId}`));
  card.appendChild(badge(active.status));
  card.appendChild(
    h(
      "div",
      { style: `font-size:13px;color:${COLORS.textMuted};` },
      `Ran ${elapsedLabel(active.startedAt)} — ${readingsForThisRun.length} reading${readingsForThisRun.length === 1 ? "" : "s"} logged`
    )
  );
  card.appendChild(h("div", { style: `font-size:16px;font-weight:700;color:${COLORS.gold};` }, `Estimated: ${estimate.toLocaleString()} bu`));
  card.appendChild(h("div", { style: `font-size:12px;color:${COLORS.textMuted};` }, "From discharge-rate readings — rough, not exact"));
  wrap.appendChild(card);

  const f = state.dryerStopForm;
  wrap.appendChild(h("div", { style: `font-size:13px;color:${COLORS.textMuted};margin-bottom:-4px;` }, "Actual bushels (optional — overrides the estimate above if you know a better number)"));
  wrap.appendChild(numField(null, `e.g. ${estimate}`, () => f.actualBushels, (v) => (f.actualBushels = v)));

  wrap.appendChild(h("div", { style: `font-size:13px;color:${COLORS.textMuted};margin-bottom:-4px;` }, "Notes"));
  wrap.appendChild(
    h(
      "textarea",
      {
        placeholder: "Optional",
        style: `${BODY}font-size:15px;padding:12px;border-radius:8px;border:1px solid ${COLORS.border};background:${COLORS.panel};color:${COLORS.text};min-height:50px;`,
        oninput: (e) => (f.notes = e.target.value),
      },
      f.notes
    )
  );

  wrap.appendChild(bigButton("Confirm stop", { tone: "gold", onClick: stopDryerRun }));
  wrap.appendChild(linkButton("← Back", () => setState({ screen: "dryerHome" })));
  return wrap;
}

async function stopDryerRun() {
  const dryerName = state.dryerCurrent;
  const active = state.dryerActive[dryerName];
  const f = state.dryerStopForm;
  const run = {
    clientId: active.runClientId, // must match what readings already reference — see queueDryerRun in db.js
    dryerName,
    sourceBinId: active.sourceBinId,
    destBinId: active.destBinId,
    crop: active.crop,
    status: active.status,
    startedAt: active.startedAt,
    endedAt: new Date().toISOString(),
    bushelsMovedActual: f.actualBushels ? Number(f.actualBushels) : null,
    workerId: active.workerId,
    notes: f.notes || null,
  };
  await queueDryerRun(run);
  await clearActiveDryerRun(dryerName);
  state.dryerActive[dryerName] = null;
  // This run is done — drop its readings from the live in-memory cache
  // (they're already queued/synced independently; nothing is lost).
  state.dryerReadings = state.dryerReadings.filter((r) => r.runClientId !== active.runClientId);
  setState({ screen: "dryerHome" });
}

function stepDots() {
  const stepIndex = { login: 0, home: 0, crop: 1, field: 2, truck: 3, bin: 4, confirm: 5, success: 5 }[state.screen];
  const total = 6;
  const row = h("div", { style: "display:flex;gap:8px;padding:18px 28px 0;" });
  for (let i = 0; i < total; i++) {
    row.appendChild(h("div", { style: `height:4px;flex:1;border-radius:2px;background:${i <= stepIndex ? COLORS.gold : COLORS.border};` }));
  }
  return row;
}

function logPanel() {
  if (state.todayLog.length === 0) return null;
  const panel = h("div", { style: `border-top:1px solid ${COLORS.border};padding:14px 28px;background:${COLORS.panel};` });
  panel.appendChild(h("div", { style: `font-size:12px;color:${COLORS.textMuted};margin-bottom:8px;letter-spacing:0.3px;` }, `Today's log (${state.todayLog.length})`));
  const rows = h("div", { style: "display:flex;flex-direction:column;gap:6px;max-height:90px;overflow-y:auto;" });
  state.todayLog.forEach((entry) => {
    const time = new Date(entry.queuedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const worker = state.workers.find((w) => w.id === entry.workerId);
    const field = state.fields.find((f) => f.id === entry.fieldId);
    const bin = state.bins.find((b) => b.id === entry.binId);
    const truckLabel = entry.truck ? `Truck ${entry.truck}` : "Buffer truck";
    const effectiveStatus = entry.isBuffer ? "conventional" : field ? field.status : null;
    rows.appendChild(
      h("div", { style: `font-size:12px;color:${COLORS.textMuted};display:flex;align-items:center;gap:8px;` }, [
        h("span", { style: `color:${COLORS.text};` }, time),
        h("span", {}, worker ? worker.name : entry.workerId),
        h("span", {}, "·"),
        h("span", {}, field ? field.name : entry.fieldId),
        h("span", {}, "·"),
        h("span", {}, truckLabel),
        h("span", {}, "·"),
        h("span", {}, entry.crop || "—"),
        h("span", {}, "·"),
        effectiveStatus ? badge(effectiveStatus) : h("span", {}, "—"),
        h("span", {}, "·"),
        h("span", {}, bin ? bin.name : entry.binId),
        !entry.synced ? h("span", { style: `color:${COLORS.amber};` }, "pending") : null,
        entry.isBuffer ? h("span", { style: `color:${COLORS.amber};` }, "buffer") : null,
      ])
    );
  });
  panel.appendChild(rows);
  return panel;
}

function render() {
  if (!root) return;
  root.innerHTML = "";
  const frame = h("div", {
    style: `${BODY}background:${COLORS.ink};min-height:100%;display:flex;flex-direction:column;`,
  });
  frame.appendChild(topBar());
  const isDryerScreen = state.screen.startsWith("dryer");
  if (state.screen !== "login" && !isDryerScreen) frame.appendChild(stepDots()); // stepDots is specific to the field-delivery flow's 5 steps

  const body = h("div", { style: "flex:1;padding:22px 28px 28px;display:flex;flex-direction:column;gap:16px;" });
  const screens = {
    login: loginScreen,
    home: homeScreen,
    crop: cropScreen,
    field: fieldScreen,
    truck: truckScreen,
    bin: binScreen,
    confirm: confirmScreen,
    success: successScreen,
    dryerHome: dryerHomeScreen,
    dryerStart: dryerStartScreen,
    dryerReading: dryerReadingScreen,
    dryerStop: dryerStopScreen,
  };
  body.appendChild(screens[state.screen]());
  frame.appendChild(body);

  const panel = state.screen !== "login" && !isDryerScreen ? logPanel() : null; // logPanel shows today's FIELD-delivery log — not relevant to the dryer flow
  if (panel) frame.appendChild(panel);

  root.appendChild(frame);

  // Scroll the pre-highlighted pick into view, but only on first arrival at
  // this screen — not on every re-render (e.g. tapping a status filter
  // shouldn't yank the scroll position back each time).
  if (state.screen !== lastScreen && (state.screen === "field" || state.screen === "bin")) {
    const selectedEl = root.querySelector('[data-selected="true"]');
    if (selectedEl) selectedEl.scrollIntoView({ block: "center", behavior: "auto" });
  }
  lastScreen = state.screen;
}

// ---------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------

export async function mountApp(el) {
  root = el;
  installInactivityWatcher();
  render(); // draw the login screen immediately, don't block on network
  await Promise.all([refreshReference(), refreshTodayLog(), restoreActiveDryerRuns()]);

  // sync.js dispatches this after every successful reference pull, so
  // a field/bin change (e.g. a clean-bin affidavit logged elsewhere)
  // shows up here without needing a manual reload.
  window.addEventListener("grainchain:reference-updated", refreshReference);
}
