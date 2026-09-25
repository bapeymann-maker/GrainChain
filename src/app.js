// app.js
// The real kiosk flow: PIN login → field → truck/load → bin → confirm.
// No framework — plain DOM building (see the `h()` helper below) so this
// stays a zero-build static site. Every write goes through queueLoad() in
// db.js first; sync.js pushes to Supabase in the background whenever the
// Chromebook has a connection.

import { queueLoad, getReference, getAllLoads } from "./db.js";

// ---------------------------------------------------------------------
// TODO: there is no `workers` table in Supabase yet — this is a
// placeholder roster with hardcoded PINs, same as the original prototype.
// Replace with a real reference table (and pull it via getReference like
// fields/bins) once that schema exists.
// ---------------------------------------------------------------------
const WORKERS = [
  { id: "w1", name: "Ben H.", pin: "4471" },
  { id: "w2", name: "Cody M.", pin: "4482" },
  { id: "w3", name: "Sam R.", pin: "4493" },
];

// TODO: these per-truck bushel figures are PLACEHOLDER values carried
// over from the original demo — they are not real trailer capacities.
// Confirm actual bushel capacity per truck/trailer before trusting the
// "full truck, no weight entry" shortcut with real data.
const TRUCKS = ["1", "2", "3", "4", "5", "6"];
const TRUCK_BUSHELS = { "1": 950, "2": 980, "3": 1000, "4": 940, "5": 970, "6": 990 };
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
  statusFilter: "All",
  cropChoice: null,

  field: null,
  bin: null,
  truck: null,
  truckMode: null, // "full" | "notFull" | "buffer"
  weight: "",
  weightError: "",
  moisture: "",
  testWeight: "",
  isBuffer: false,

  todayLog: [],
};

let root = null;

function setState(patch) {
  Object.assign(state, patch);
  render();
}

async function refreshReference() {
  const [fields, bins] = await Promise.all([getReference("fields"), getReference("bins")]);
  setState({ fields: fields || [], bins: bins || [] });
}

async function refreshTodayLog() {
  const all = await getAllLoads();
  const today = new Date().toDateString();
  const todays = all
    .filter((l) => new Date(l.queuedAt).toDateString() === today)
    .sort((a, b) => new Date(b.queuedAt) - new Date(a.queuedAt));
  setState({ todayLog: todays });
}

function clearTruckFields() {
  Object.assign(state, {
    truck: null,
    truckMode: null,
    weight: "",
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
    const match = WORKERS.find((w) => w.pin === state.pin);
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

  wrap.appendChild(
    bigButton("Field delivery", {
      tone: "gold",
      sub: "Pit → wet bin, at the home site",
      onClick: () => setState({ screen: "crop" }),
    })
  );
  wrap.appendChild(bigButton("Elevator delivery (Danube / Fairfax)", { disabled: true, sub: "Coming in a later phase" }));
  wrap.appendChild(bigButton("View bin levels", { disabled: true, sub: "Coming in a later phase" }));
  wrap.appendChild(
    bigButton("Grain status review (dryer operator)", {
      disabled: true,
      sub: "Coming in a later phase — dryer operator will set/confirm status as grain moves out of the wet bin",
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
    wrap.appendChild(h("div", { style: `font-size:13px;color:${COLORS.textMuted};margin-top:4px;margin-bottom:-4px;` }, "Weight (lb), as read to you by the cart driver"));
    wrap.appendChild(
      h("input", {
        inputmode: "decimal",
        placeholder: "e.g. 62,400",
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
            setState({ weightError: "Enter the weight the cart driver read off the scale." });
            return;
          }
        }
        setState({ weightError: "", screen: "bin" });
      },
    })
  );
  wrap.appendChild(linkButton("← Back", () => setState({ screen: "field" })));
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
  return wrap;
}

function confirmScreen() {
  const { field, bin, worker, truck, truckMode, weight, moisture, testWeight, isBuffer } = state;
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
        ? `${Number(weight).toLocaleString()} lb (estimated)`
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
  const { worker, field, bin, truck, truckMode, weight, moisture, testWeight, isBuffer, cropChoice } = state;
  await queueLoad({
    workerId: worker.id,
    fieldId: field.id,
    crop: cropChoice,
    truck: truckMode === "buffer" ? null : truck,
    truckMode,
    bushels: truckMode === "full" ? TRUCK_BUSHELS[truck] : null,
    weightLb: truckMode === "buffer" || truckMode === "notFull" ? Number(weight) : null,
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
    const worker = WORKERS.find((w) => w.id === entry.workerId);
    const field = state.fields.find((f) => f.id === entry.fieldId);
    const bin = state.bins.find((b) => b.id === entry.binId);
    rows.appendChild(
      h("div", { style: `font-size:12px;color:${COLORS.textMuted};display:flex;gap:8px;` }, [
        h("span", { style: `color:${COLORS.text};` }, time),
        h("span", {}, worker ? worker.name : entry.workerId),
        h("span", {}, "·"),
        h("span", {}, `${field ? field.name : entry.fieldId} → ${bin ? bin.name : entry.binId}`),
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
  if (state.screen !== "login") frame.appendChild(stepDots());

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
  };
  body.appendChild(screens[state.screen]());
  frame.appendChild(body);

  const panel = state.screen !== "login" ? logPanel() : null;
  if (panel) frame.appendChild(panel);

  root.appendChild(frame);
}

// ---------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------

export async function mountApp(el) {
  root = el;
  render(); // draw the login screen immediately, don't block on network
  await Promise.all([refreshReference(), refreshTodayLog()]);

  // sync.js dispatches this after every successful reference pull, so
  // a field/bin change (e.g. a clean-bin affidavit logged elsewhere)
  // shows up here without needing a manual reload.
  window.addEventListener("grainchain:reference-updated", refreshReference);
}
