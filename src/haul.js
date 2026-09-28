// haul.js
// Outbound hauls: a driver fills a trailer from a bin and takes it to a
// buyer. Two phases:
//   1. Start a haul (trailer -> bin -> destination -> estimate). Saved
//      instantly, works offline.
//   2. After unloading, open the haul from "Scale tickets" and enter the
//      real numbers from the scale ticket plus a photo of it. Corrections
//      are appended as newer ticket rows (newest wins), never overwritten.
//
// Kept separate from app.js so the field-delivery flow is untouched.
// app.js hands us its state and UI helpers via createHaul(ctx).

import { queueShipment, queueTicket, getAllShipments, getAllTickets } from "./db.js";
import { syncSoon } from "./sync.js";

const CROPS = ["Corn", "Soybeans", "Oats"];
// Standard commercial bushel weights. Used only to pre-fill net bushels;
// the ticket's own bushel figure always wins if entered.
const STANDARD_LB_PER_BU = { Corn: 56, Soybeans: 60, Oats: 32 };
const HAUL_WINDOW_MS = 4 * 24 * 60 * 60 * 1000; // matches recent_shipments view

const TRUCK_NUMBERS = ["1", "2", "3", "4", "5", "6", "7", "8"]; // tractor / truck numbers
const normCrop = (c) => (c === "Beans" ? "Soybeans" : c || null);
const num = (v) => (v === "" || v == null || isNaN(Number(v)) ? null : Number(v));
const round2 = (n) => Math.round(n * 100) / 100;
const fmtNum = (n, d = 0) => Number(n).toLocaleString(undefined, { maximumFractionDigits: d });
const fmtTime = (iso) =>
  new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

// Resize/re-encode a photo so it uploads quickly over a weak connection.
async function compressImage(file, maxDim = 1600, quality = 0.8) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/jpeg", quality)
  );
}

export function createHaul(ctx) {
  const { state, setState, h, bigButton, linkButton, badge, COLORS, HEAD, BODY, TRUCKS, TRUCK_BUSHELS } = ctx;
  const rerender = () => setState({});

  // What the driver has picked so far for a new haul. Persists between
  // hauls so the last trailer/bin/destination come up pre-highlighted.
  const haul = {
    truck: null,
    trailer: null,
    destCustom: false, // true when the driver typed a destination that isn't in the list
    destName: "",
    destLocation: "",
    origin: null, // "bin" | "field" — null until the driver has chosen once
    binId: null,
    site: null,
    fieldId: null,
    fieldCrop: "All",
    fieldQuery: "",
    destId: null,
    crop: null,
    estMode: "full", // "full" | "custom"
    estUnit: "bu", // "bu" | "lb"
    estValue: "",
    error: "",
    saving: false,
    listFilter: null, // "mine" | "all"
    done: null, // { title, line, note } for the confirmation screen
  };

  // The ticket form currently being filled in.
  const ticket = {
    shipment: null, // the merged haul row being ticketed
    number: "",
    gross: "",
    tare: "",
    net: "",
    bushels: "",
    moisture: "",
    testWeight: "",
    notes: "",
    photo: null,
    photoUrl: null,
    photoBusy: false,
    hadPhoto: false,
    priorPhotoPath: null,
    error: "",
    saving: false,
  };

  // This device's own not-yet-(or-just)-synced records.
  const local = { shipments: [], tickets: [] };

  async function refreshLocal(quiet = false) {
    const [s, t] = await Promise.all([getAllShipments(), getAllTickets()]);
    local.shipments = s;
    local.tickets = t;
    if (!quiet) rerender();
  }

  // ---------- small UI helpers ----------
  const col = () => h("div", { style: "display:flex;flex-direction:column;gap:14px;" });
  const add = (parent, ...kids) => {
    kids.forEach((k) => k && parent.appendChild(k));
    return parent;
  };
  const title = (t) => h("div", { style: `${HEAD}font-size:22px;font-weight:700;color:${COLORS.text};` }, t);
  const hint = (t) => h("div", { style: `font-size:13px;color:${COLORS.textMuted};margin-top:-8px;` }, t);
  const label = (t) => h("div", { style: `font-size:13px;color:${COLORS.textMuted};` }, t);
  const errorLine = (t) => (t ? h("div", { style: `font-size:13px;color:${COLORS.danger};` }, t) : null);
  const emptyNote = (t) =>
    h("div", { style: `border:1px dashed ${COLORS.border};border-radius:10px;padding:20px;color:${COLORS.textMuted};font-size:13px;text-align:center;` }, t);
  const choiceStyle = (selected) =>
    `${BODY}padding:14px 16px;border-radius:10px;border:1px solid ${selected ? COLORS.gold : COLORS.border};background:${selected ? COLORS.goldDark : COLORS.panelAlt};color:${selected ? COLORS.gold : COLORS.text};font-size:15px;font-weight:600;cursor:pointer;text-align:left;`;
  const inputStyle = `${BODY}font-size:18px;padding:12px;border-radius:8px;border:1px solid ${COLORS.border};background:${COLORS.panel};color:${COLORS.text};width:100%;box-sizing:border-box;`;

  const binById = (id) => state.bins.find((b) => b.id === id);
  const binLabel = (id) => (binById(id) || {}).name || id || "—";
  const fieldById = (id) => state.fields.find((f) => f.id === id);
  // Where a haul started, as one readable label.
  const originLabel = (x) =>
    x.origin_type === "field" ? `${(fieldById(x.field_id) || {}).name || x.field_id || "—"} (field)` : binLabel(x.bin_id);
  const destById = (id) => state.destinations.find((d) => d.id === id);
  const destLabel = (id) => {
    const d = destById(id);
    if (!d) return id || "—";
    return d.location ? `${d.name} (${d.location.split(",")[0]})` : d.name;
  };
  // A destination as text: a typed-in one, or a listed one looked up by id.
  const destText = (x) => {
    if (x.destination_name) {
      const town = (x.destination_location || "").split(",")[0].trim();
      return town ? `${x.destination_name} (${town})` : x.destination_name;
    }
    return destLabel(x.destination_id);
  };
  const rigLabel = (x) => (x.truck ? `Truck ${x.truck} · ${x.trailer}` : x.trailer);
  // Places drivers typed in the last few days, so the next driver can tap
  // one instead of re-typing it (keeps the spelling consistent).
  function recentCustomDestinations() {
    const seen = new Map();
    const push = (name, location, at) => {
      if (!name) return;
      const key = `${name}|${location || ""}`.toLowerCase();
      if (!seen.has(key) || seen.get(key).at < at) seen.set(key, { name, location: location || "", at });
    };
    (state.recentShipments || []).forEach((s) => push(s.destination_name, s.destination_location, s.departed_at));
    local.shipments.forEach((s) => push(s.destinationName, s.destinationLocation, s.departedAt));
    return [...seen.values()].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 6);
  }
  const workerName = (id) => (state.workers.find((w) => w.id === id) || {}).name || id || "—";
  const eligibleBins = () =>
    state.bins.filter((b) => (b.bin_type === "storage" || b.bin_type === "wet") && b.active !== false);

  // Server view of recent hauls + this device's own records, merged by
  // client_id. A newer local ticket overrides an older server one.
  function mergedHauls() {
    const cutoff = Date.now() - HAUL_WINDOW_MS;
    const map = new Map();
    (state.recentShipments || []).forEach((s) => map.set(s.client_id, { ...s }));
    local.shipments.forEach((s) => {
      if (map.has(s.clientId)) return;
      map.set(s.clientId, {
        client_id: s.clientId,
        departed_at: s.departedAt,
        worker_id: s.workerId,
        truck: s.truck,
        trailer: s.trailer,
        bin_id: s.binId,
        field_id: s.fieldId,
        origin_type: s.originType || "bin",
        origin_status: s.originStatus,
        crop: s.crop,
        bin_status: s.binStatus,
        destination_id: s.destinationId,
        destination_name: s.destinationName,
        destination_location: s.destinationLocation,
        est_bushels: s.estBushels,
        est_weight_lb: s.estWeightLb,
        unsynced: !s.synced,
      });
    });
    const newest = new Map();
    local.tickets.forEach((t) => {
      const cur = newest.get(t.shipmentClientId);
      if (!cur || t.createdAt > cur.createdAt) newest.set(t.shipmentClientId, t);
    });
    newest.forEach((t, sid) => {
      const s = map.get(sid);
      if (!s) return;
      if (!s.ticket_at || t.createdAt > s.ticket_at) {
        Object.assign(s, {
          ticket_number: t.ticketNumber,
          gross_lb: t.grossLb,
          tare_lb: t.tareLb,
          net_lb: t.netLb,
          net_bushels: t.netBushels,
          moisture_pct: t.moisturePct,
          test_weight: t.testWeight,
          notes: t.notes,
          photo_path: t.photoPath || s.photo_path,
          ticket_at: t.createdAt,
          local_photo: !!t.photo,
          unsyncedTicket: !t.synced,
        });
      }
    });
    return [...map.values()]
      .filter((s) => new Date(s.departed_at).getTime() >= cutoff)
      .sort((a, b) => new Date(b.departed_at) - new Date(a.departed_at));
  }

  // ---------- 1. Trailer ----------
  function trailerScreen() {
    const wrap = col();
    add(wrap, title("Truck and trailer"), hint("Pick your truck number and the trailer you're pulling."));
    const grid = (values, current, pick) => {
      const g = h("div", { style: "display:grid;grid-template-columns:repeat(4,1fr);gap:8px;" });
      values.forEach((v) =>
        g.appendChild(
          h(
            "button",
            {
              style: `${choiceStyle(current === v)}text-align:center;font-size:16px;font-weight:700;padding:14px 8px;`,
              onclick: () => {
                pick(v);
                haul.error = "";
                rerender();
              },
            },
            v
          )
        )
      );
      return g;
    };
    add(wrap, label("Truck #"), grid(TRUCK_NUMBERS, haul.truck, (v) => (haul.truck = v)));
    add(wrap, label("Trailer"), grid(TRUCKS, haul.trailer, (v) => (haul.trailer = v)));
    add(wrap, errorLine(haul.error));
    add(
      wrap,
      bigButton("Next", {
        tone: "gold",
        onClick: () => {
          if (!haul.truck || !haul.trailer) {
            haul.error = "Pick both a truck number and a trailer.";
            rerender();
            return;
          }
          haul.error = "";
          setState({ screen: "haulOrigin" });
        },
      })
    );
    add(wrap, linkButton("← Back", () => setState({ screen: "home" })));
    return wrap;
  }

  // ---------- 1b. Where is the grain coming from? ----------
  function originScreen() {
    const wrap = col();
    add(wrap, title("Where's the grain coming from?"));
    const option = (value, heading, sub, screen) => {
      const selected = haul.origin === value;
      return h(
        "button",
        {
          style: choiceStyle(selected),
          onclick: () => {
            haul.origin = value;
            setState({ screen });
          },
        },
        [
          h("div", { style: "font-size:17px;font-weight:600;" }, heading),
          h("div", { style: `font-size:13px;font-weight:400;color:${selected ? COLORS.gold : COLORS.textMuted};` }, selected ? sub + " · same as last haul" : sub),
        ]
      );
    };
    add(
      wrap,
      option("bin", "From a bin", "Grain that's already in a bin", "haulBin"),
      option("field", "From a field", "Straight from the field — wet or dry", "haulField"),
      linkButton("← Back", () => setState({ screen: "haulTrailer" }))
    );
    return wrap;
  }

  // ---------- 2b. Field (when hauling straight from a field) ----------
  function fieldScreen() {
    const wrap = col();
    add(wrap, title("Which field?"), hint("Straight from the field to the buyer."));
    if (state.fields.length === 0) {
      add(wrap, emptyNote("No fields synced yet. Make sure this device has connected to the internet at least once since setup."));
      add(wrap, linkButton("← Back", () => setState({ screen: "haulOrigin" })));
      return wrap;
    }
    add(
      wrap,
      h(
        "div",
        { style: "display:flex;gap:8px;flex-wrap:wrap;" },
        ["All", ...CROPS].map((c) =>
          h(
            "button",
            {
              style: `${choiceStyle(haul.fieldCrop === c)}padding:10px 14px;font-size:13px;`,
              onclick: () => {
                haul.fieldCrop = c;
                rerender();
              },
            },
            c
          )
        )
      )
    );

    const list = h("div", { style: "display:flex;flex-direction:column;gap:10px;" });
    // Typing in the search box hides/shows rows in place. It deliberately
    // does NOT redraw the screen, so the keyboard stays open on a phone.
    const applyQuery = () => {
      const q = haul.fieldQuery;
      [...list.children].forEach((row) => {
        row.style.display = !q || (row.getAttribute("data-name") || "").includes(q) ? "" : "none";
      });
    };
    add(
      wrap,
      h("input", {
        type: "search",
        placeholder: "Search fields…",
        value: haul.fieldQuery,
        style: inputStyle,
        oninput: (e) => {
          haul.fieldQuery = e.target.value.trim().toLowerCase();
          applyQuery();
        },
      })
    );

    const shown = state.fields
      .filter((f) => haul.fieldCrop === "All" || normCrop(f.crop) === haul.fieldCrop)
      .sort((a, b) => a.name.localeCompare(b.name));
    if (shown.length === 0) {
      add(wrap, emptyNote(`No ${haul.fieldCrop} fields are set up yet.`));
    }
    shown.forEach((f) => {
      const selected = haul.fieldId === f.id;
      list.appendChild(
        h(
          "button",
          {
            style: `${choiceStyle(selected)}display:flex;align-items:center;justify-content:space-between;gap:10px;`,
            "data-name": f.name.toLowerCase(),
            "data-selected": selected ? "true" : null,
            onclick: () => {
              haul.fieldId = f.id;
              haul.crop = normCrop(f.crop) || haul.crop;
              setState({ screen: "haulDest" });
            },
          },
          [
            h("div", {}, [
              h("div", { style: "font-size:16px;font-weight:600;" }, f.name),
              h(
                "div",
                { style: `font-size:13px;font-weight:400;color:${selected ? COLORS.gold : COLORS.textMuted};` },
                `${f.acres ? fmtNum(f.acres, 1) + " ac" : "acres not set"} · ${normCrop(f.crop) || "crop not set"}${selected ? " · same as last haul" : ""}`
              ),
            ]),
            f.status ? badge(f.status) : null,
          ]
        )
      );
    });
    applyQuery();
    add(wrap, list, linkButton("← Back", () => setState({ screen: "haulOrigin" })));
    return wrap;
  }

  // ---------- 2. Bin ----------
  function binScreen() {
    const wrap = col();
    add(wrap, title("Loading from which bin?"));
    const bins = eligibleBins();
    if (bins.length === 0) {
      add(wrap, emptyNote("No bins synced yet. Make sure this device has connected to the internet at least once since setup."));
      add(wrap, linkButton("← Back", () => setState({ screen: "haulOrigin" })));
      return wrap;
    }
    const sites = [...new Set(bins.map((b) => b.site))];
    if (!haul.site || !sites.includes(haul.site)) {
      haul.site = (binById(haul.binId) || {}).site || (sites.includes("HOME") ? "HOME" : sites[0]);
    }
    add(
      wrap,
      h(
        "div",
        { style: "display:flex;gap:8px;flex-wrap:wrap;" },
        sites.map((site) =>
          h(
            "button",
            {
              style: `${choiceStyle(haul.site === site)}padding:10px 14px;font-size:13px;`,
              onclick: () => {
                haul.site = site;
                rerender();
              },
            },
            site
          )
        )
      )
    );
    const list = h("div", { style: "display:flex;flex-direction:column;gap:10px;" });
    bins
      .filter((b) => b.site === haul.site)
      .forEach((b) => {
        const selected = haul.binId === b.id;
        list.appendChild(
          h(
            "button",
            {
              style: `${choiceStyle(selected)}display:flex;align-items:center;justify-content:space-between;`,
              "data-selected": selected ? "true" : null,
              onclick: () => {
                haul.binId = b.id;
                haul.crop = normCrop(b.crop) || haul.crop;
                setState({ screen: "haulDest" });
              },
            },
            [
              h("div", {}, [
                h("div", { style: "font-size:16px;font-weight:600;" }, b.name),
                h(
                  "div",
                  { style: `font-size:13px;font-weight:400;color:${selected ? COLORS.gold : COLORS.textMuted};` },
                  `${normCrop(b.crop) || "—"} · ${b.pct}% full${selected ? " · same as last haul" : ""}`
                ),
              ]),
              b.bin_type === "wet"
                ? h(
                    "span",
                    { style: `${BODY}font-size:12px;font-weight:700;color:${COLORS.amber};background:${COLORS.amberDark};padding:4px 10px;border-radius:999px;white-space:nowrap;` },
                    "Wet / staging"
                  )
                : b.status
                ? badge(b.status)
                : null,
            ]
          )
        );
      });
    add(wrap, list, linkButton("← Back", () => setState({ screen: "haulOrigin" })));
    return wrap;
  }

  // ---------- 3. Destination ----------
  function destScreen() {
    const wrap = col();
    add(wrap, title("Where is it going?"));
    const dests = state.destinations.filter((d) => d.active !== false);
    if (dests.length === 0) {
      add(wrap, emptyNote("No destinations synced yet. Make sure this device has connected to the internet, and that destinations have been added."));
    } else {
      dests.forEach((d) => {
        const selected = haul.destId === d.id;
        add(
          wrap,
          h(
            "button",
            {
              style: choiceStyle(selected),
              onclick: () => {
                haul.destId = d.id;
                haul.destCustom = false;
                haul.error = "";
                setState({ screen: "haulConfirm" });
              },
            },
            [
              h("div", { style: "font-size:16px;font-weight:600;" }, d.name),
              h(
                "div",
                { style: `font-size:13px;font-weight:400;color:${selected ? COLORS.gold : COLORS.textMuted};` },
                `${d.location || ""}${selected ? (d.location ? " · " : "") + "same as last haul" : ""}`
              ),
            ]
          )
        );
      });
    }
    add(
      wrap,
      h(
        "button",
        {
          style: `${choiceStyle(haul.destCustom)}border-style:dashed;`,
          onclick: () => {
            haul.error = "";
            setState({ screen: "haulDestNew" });
          },
        },
        [
          h("div", { style: "font-size:16px;font-weight:600;" }, "Somewhere new — type it in"),
          h(
            "div",
            { style: `font-size:13px;font-weight:400;color:${haul.destCustom ? COLORS.gold : COLORS.textMuted};` },
            haul.destCustom ? `Same as last haul: ${haul.destName}` : "A buyer or place that isn't in this list"
          ),
        ]
      )
    );
    add(wrap, linkButton("← Back", () => setState({ screen: haul.origin === "field" ? "haulField" : "haulBin" })));
    return wrap;
  }

  // ---------- 3b. A destination we haven't delivered to before ----------
  function destNewScreen() {
    const wrap = col();
    add(wrap, title("New destination"), hint("Type where you're taking it — the buyer's name and the town."));
    const recent = recentCustomDestinations();
    if (recent.length) {
      add(wrap, label("Someone typed these recently — tap one to reuse it"));
      add(
        wrap,
        h(
          "div",
          { style: "display:flex;gap:8px;flex-wrap:wrap;" },
          recent.map((r) =>
            h(
              "button",
              {
                style: `${choiceStyle(false)}padding:10px 14px;font-size:14px;`,
                onclick: () => {
                  haul.destName = r.name;
                  haul.destLocation = r.location;
                  haul.error = "";
                  rerender();
                },
              },
              r.location ? `${r.name} (${r.location})` : r.name
            )
          )
        )
      );
    }
    const input = (text, key, placeholder) =>
      h("div", { style: "display:flex;flex-direction:column;gap:6px;" }, [
        label(text),
        h("input", {
          type: "text",
          placeholder,
          value: haul[key],
          style: inputStyle,
          oninput: (e) => {
            haul[key] = e.target.value;
            haul.error = "";
          },
        }),
      ]);
    add(wrap, input("Buyer or place name", "destName", "Buyer or place name"), input("Town, state (optional)", "destLocation", "City, ST"));
    add(wrap, errorLine(haul.error));
    add(
      wrap,
      bigButton("Use this destination", {
        tone: "gold",
        onClick: () => {
          const name = haul.destName.replace(/\s+/g, " ").trim();
          if (name.length < 2) {
            haul.error = "Type the buyer's or place's name.";
            rerender();
            return;
          }
          haul.destName = name;
          haul.destLocation = haul.destLocation.replace(/\s+/g, " ").trim();
          haul.destCustom = true;
          haul.destId = null;
          haul.error = "";
          setState({ screen: "haulConfirm" });
        },
      })
    );
    add(wrap, linkButton("← Back", () => setState({ screen: "haulDest" })));
    return wrap;
  }

  // ---------- 4. Confirm + estimate ----------
  function confirmScreen() {
    const isField = haul.origin === "field";
    const bin = isField ? null : binById(haul.binId);
    const field = isField ? fieldById(haul.fieldId) : null;
    const originStatus = isField ? field && field.status : bin && bin.status;
    const wrap = col();
    if (!haul.truck || !haul.trailer || (!bin && !field) || (!haul.destId && !haul.destCustom)) {
      add(wrap, emptyNote("Something's missing — start the haul again."), linkButton("← Home", () => setState({ screen: "home" })));
      return wrap;
    }
    add(wrap, title("Confirm haul"));

    const rows = [
      ["Driver", state.worker.name],
      ["Truck", `#${haul.truck}`],
      ["Trailer", haul.trailer],
      isField
        ? ["From field", `${field.name}${field.acres ? " · " + fmtNum(field.acres, 1) + " ac" : ""}`]
        : ["From bin", `${bin.name} (${bin.site})`],
      ["Destination", haul.destCustom ? destText({ destination_name: haul.destName, destination_location: haul.destLocation }) : destLabel(haul.destId)],
    ];
    const card = h("div", {
      style: `background:${COLORS.panelAlt};border:1px solid ${COLORS.border};border-radius:10px;padding:16px 18px;display:flex;flex-direction:column;gap:10px;`,
    });
    rows.forEach(([k, v]) =>
      card.appendChild(
        h("div", { style: "display:flex;justify-content:space-between;gap:12px;" }, [
          h("span", { style: `font-size:13px;color:${COLORS.textMuted};` }, k),
          h("span", { style: `font-size:14px;color:${COLORS.text};text-align:right;` }, v),
        ])
      )
    );
    if (originStatus) {
      card.appendChild(
        h("div", { style: "display:flex;justify-content:space-between;align-items:center;" }, [
          h("span", { style: `font-size:13px;color:${COLORS.textMuted};` }, isField ? "Field status" : "Bin status"),
          badge(originStatus),
        ])
      );
    }
    add(wrap, card);
    if (haul.destCustom) {
      add(wrap, h("div", { style: `font-size:12px;color:${COLORS.amber};margin-top:-6px;` }, "New destination — it isn't in the list yet, so it's saved exactly as you typed it."));
    }

    add(wrap, label("Crop"));
    add(
      wrap,
      h(
        "div",
        { style: "display:flex;gap:8px;" },
        CROPS.map((c) =>
          h(
            "button",
            {
              style: `${choiceStyle(haul.crop === c)}flex:1;text-align:center;padding:10px;font-size:14px;`,
              onclick: () => {
                haul.crop = c;
                rerender();
              },
            },
            c
          )
        )
      )
    );

    add(wrap, label("Estimated load — you'll replace this with the scale ticket numbers later"));
    add(
      wrap,
      h(
        "button",
        {
          style: choiceStyle(haul.estMode === "full"),
          onclick: () => {
            haul.estMode = "full";
            haul.error = "";
            rerender();
          },
        },
        `Full trailer — about ${fmtNum(TRUCK_BUSHELS[haul.trailer] || 0)} bu`
      )
    );
    add(
      wrap,
      h(
        "button",
        {
          style: choiceStyle(haul.estMode === "custom"),
          onclick: () => {
            haul.estMode = "custom";
            haul.error = "";
            rerender();
          },
        },
        "Enter an amount"
      )
    );
    if (haul.estMode === "custom") {
      add(
        wrap,
        h(
          "div",
          { style: "display:flex;gap:8px;" },
          [["bu", "Bushels"], ["lb", "Weight (lb)"]].map(([u, text]) =>
            h(
              "button",
              {
                style: `${choiceStyle(haul.estUnit === u)}flex:1;text-align:center;padding:10px;font-size:14px;`,
                onclick: () => {
                  haul.estUnit = u;
                  rerender();
                },
              },
              text
            )
          )
        )
      );
      add(
        wrap,
        h("input", {
          inputmode: "decimal",
          placeholder: haul.estUnit === "bu" ? "e.g. 900" : "e.g. 50,000",
          value: haul.estValue,
          style: inputStyle,
          oninput: (e) => {
            haul.estValue = e.target.value.replace(/[^0-9.]/g, "");
            haul.error = "";
          },
        })
      );
    }

    add(wrap, errorLine(haul.error));
    add(wrap, bigButton("Start haul — heading out", { tone: "gold", onClick: startHaul }));
    add(wrap, linkButton("← Back", () => setState({ screen: "haulDest" })));
    return wrap;
  }

  async function startHaul() {
    if (haul.saving) return;
    const isField = haul.origin === "field";
    const bin = isField ? null : binById(haul.binId);
    const field = isField ? fieldById(haul.fieldId) : null;
    const originName = isField ? `${field.name} (field)` : bin.name;
    const destination = haul.destCustom
      ? { destination_name: haul.destName, destination_location: haul.destLocation }
      : { destination_id: haul.destId };
    let estBushels = null;
    let estWeightLb = null;
    if (haul.estMode === "full") {
      estBushels = TRUCK_BUSHELS[haul.trailer] || null;
    } else {
      const v = num(haul.estValue);
      if (!(v > 0)) {
        haul.error = "Enter the estimated amount, or choose Full trailer.";
        rerender();
        return;
      }
      if (haul.estUnit === "bu") estBushels = v;
      else estWeightLb = v;
    }
    haul.saving = true;
    try {
      await queueShipment({
        workerId: state.worker.id,
        truck: haul.truck,
        trailer: haul.trailer,
        originType: isField ? "field" : "bin",
        binId: bin ? bin.id : null,
        fieldId: field ? field.id : null,
        crop: haul.crop,
        binStatus: bin ? bin.status || null : null,
        originStatus: (isField ? field.status : bin.status) || null,
        destinationId: haul.destCustom ? null : haul.destId,
        destinationName: haul.destCustom ? haul.destName : null,
        destinationLocation: haul.destCustom ? haul.destLocation || null : null,
        estBushels,
        estWeightLb,
      });
      await refreshLocal(true);
      haul.done = {
        title: "Haul started",
        line: `Truck ${haul.truck} · ${haul.trailer} · ${originName} → ${destText(destination)}`,
        note: "When you get your scale ticket, open “Scale tickets” on the home screen to enter the numbers and take a photo of it.",
      };
      haul.estMode = "full";
      haul.estValue = "";
      haul.error = "";
      setState({ screen: "haulDone" });
      syncSoon();
    } catch (err) {
      console.error("Could not save haul", err);
      haul.error = "Couldn't save the haul on this device. Try again.";
      rerender();
    } finally {
      haul.saving = false;
    }
  }

  // ---------- Confirmation ----------
  function doneScreen() {
    const d = haul.done || { title: "Saved", line: "", note: "" };
    const wrap = h("div", { style: "display:flex;flex-direction:column;align-items:center;gap:16px;margin-top:20px;" });
    add(
      wrap,
      h(
        "div",
        { style: `width:64px;height:64px;border-radius:50%;background:${COLORS.organicDark};color:${COLORS.organic};display:flex;align-items:center;justify-content:center;font-size:28px;` },
        "✓"
      ),
      h("div", { style: `${HEAD}font-size:22px;font-weight:700;color:${COLORS.text};` }, d.title),
      h("div", { style: `font-size:14px;color:${COLORS.textMuted};text-align:center;` }, d.line),
      d.note ? h("div", { style: `font-size:13px;color:${COLORS.textMuted};text-align:center;max-width:360px;` }, d.note) : null,
      h("div", { style: "width:100%;max-width:360px;" }, [bigButton("Back to home", { tone: "gold", onClick: () => setState({ screen: "home" }) })]),
      linkButton("Scale tickets", () => setState({ screen: "haulList" }), COLORS.gold)
    );
    return wrap;
  }

  // ---------- List of recent hauls ----------
  function listScreen() {
    const wrap = col();
    add(wrap, title("Scale tickets"), hint("Tap a haul to enter or fix its scale ticket."));
    const all = mergedHauls();
    const mine = all.filter((x) => state.worker && x.worker_id === state.worker.id);
    const filter = haul.listFilter || (mine.length ? "mine" : "all");
    const shown = filter === "mine" ? mine : all;

    add(
      wrap,
      h(
        "div",
        { style: "display:flex;gap:8px;" },
        [["mine", `My hauls (${mine.length})`], ["all", `Everyone's (${all.length})`]].map(([k, text]) =>
          h(
            "button",
            {
              style: `${choiceStyle(filter === k)}flex:1;text-align:center;padding:10px;font-size:14px;`,
              onclick: () => {
                haul.listFilter = k;
                rerender();
              },
            },
            text
          )
        )
      )
    );

    if (shown.length === 0) {
      add(wrap, emptyNote("No hauls in the last few days. Start one from the home screen."));
    }
    shown.forEach((x) => {
      const hasTicket = !!x.ticket_at;
      const est =
        x.est_bushels != null ? `${fmtNum(x.est_bushels)} bu` : x.est_weight_lb != null ? `${fmtNum(x.est_weight_lb)} lb` : "—";
      const chipText = hasTicket
        ? `Ticket ✓${x.net_bushels != null ? " · " + fmtNum(x.net_bushels) + " bu" : ""}`
        : "Needs ticket";
      const notSynced = x.unsynced || x.unsyncedTicket;
      wrap.appendChild(
        h(
          "button",
          {
            style: `${choiceStyle(false)}display:flex;align-items:center;justify-content:space-between;gap:10px;`,
            onclick: () => openTicket(x),
          },
          [
            h("div", {}, [
              h("div", { style: "font-size:15px;font-weight:600;" }, `${rigLabel(x)} · ${originLabel(x)} → ${destText(x)}`),
              h(
                "div",
                { style: `font-size:12px;font-weight:400;color:${COLORS.textMuted};` },
                `${workerName(x.worker_id)} · ${fmtTime(x.departed_at)}${hasTicket ? "" : " · est. " + est}${notSynced ? " · not synced yet" : ""}`
              ),
            ]),
            h(
              "span",
              {
                style: `${BODY}font-size:12px;font-weight:700;white-space:nowrap;padding:4px 10px;border-radius:999px;color:${hasTicket ? COLORS.organic : COLORS.amber};background:${hasTicket ? COLORS.organicDark : COLORS.amberDark};`,
              },
              chipText
            ),
          ]
        )
      );
    });
    add(wrap, linkButton("← Back", () => setState({ screen: "home" })));
    return wrap;
  }

  // ---------- Scale ticket form ----------
  function openTicket(x) {
    if (ticket.photoUrl) URL.revokeObjectURL(ticket.photoUrl);
    const s = (v) => (v == null ? "" : String(v));
    Object.assign(ticket, {
      shipment: x,
      number: s(x.ticket_number),
      gross: s(x.gross_lb),
      tare: s(x.tare_lb),
      net: s(x.net_lb),
      bushels: s(x.net_bushels),
      moisture: s(x.moisture_pct),
      testWeight: s(x.test_weight),
      notes: s(x.notes),
      photo: null,
      photoUrl: null,
      photoBusy: false,
      hadPhoto: !!(x.photo_path || x.local_photo),
      priorPhotoPath: x.photo_path || null,
      error: "",
      saving: false,
    });
    setState({ screen: "haulTicket" });
  }

  async function choosePhoto(file) {
    ticket.photoBusy = true;
    rerender();
    let blob = file;
    try {
      blob = await compressImage(file);
    } catch (err) {
      console.warn("Could not compress photo; using the original", err);
    }
    if (ticket.photoUrl) URL.revokeObjectURL(ticket.photoUrl);
    ticket.photo = blob;
    ticket.photoUrl = URL.createObjectURL(blob);
    ticket.photoBusy = false;
    ticket.error = "";
    rerender();
  }

  function ticketScreen() {
    const x = ticket.shipment;
    const wrap = col();
    if (!x) {
      add(wrap, emptyNote("Pick a haul first."), linkButton("← Back", () => setState({ screen: "haulList" })));
      return wrap;
    }
    add(wrap, title("Scale ticket"));
    add(
      wrap,
      h("div", { style: `font-size:13px;color:${COLORS.textMuted};margin-top:-8px;` }, [
        h("div", { style: `color:${COLORS.text};font-weight:600;` }, `${rigLabel(x)} · ${originLabel(x)} → ${destText(x)}`),
        h("div", {}, `${normCrop(x.crop) || ""} · left ${fmtTime(x.departed_at)}`),
      ])
    );

    const field = (text, key, opts = {}) => {
      const numeric = opts.numeric !== false;
      return h("div", { style: "display:flex;flex-direction:column;gap:6px;flex:1;min-width:0;" }, [
        label(text),
        h("input", {
          inputmode: numeric ? "decimal" : "text",
          placeholder: opts.placeholder || "",
          value: ticket[key],
          style: inputStyle,
          oninput: (e) => {
            ticket[key] = numeric ? e.target.value.replace(/[^0-9.]/g, "") : e.target.value;
            ticket.error = "";
          },
        }),
      ]);
    };
    const row = (...kids) => h("div", { style: "display:flex;gap:10px;" }, kids);

    add(wrap, row(field("Ticket number", "number", { numeric: false })));
    add(wrap, row(field("Gross weight (lb)", "gross"), field("Tare weight (lb)", "tare")));
    add(wrap, row(field("Net weight (lb)", "net", { placeholder: "gross − tare" })));
    add(wrap, row(field("Net bushels", "bushels", { placeholder: "auto if blank" })));
    add(wrap, row(field("Moisture %", "moisture"), field("Test weight (lb/bu)", "testWeight")));
    add(wrap, row(field("Notes (optional)", "notes", { numeric: false })));
    add(
      wrap,
      h(
        "div",
        { style: `font-size:12px;color:${COLORS.textMuted};margin-top:-6px;` },
        "Net weight is filled in from gross − tare if you leave it blank. Net bushels is calculated at standard bushel weight (not adjusted for moisture) if left blank — type the ticket's own bushel figure to override."
      )
    );

    // Photo
    const fileInput = h("input", {
      type: "file",
      accept: "image/*",
      capture: "environment",
      style: "display:none;",
      onchange: (e) => {
        const f = e.target.files && e.target.files[0];
        if (f) choosePhoto(f);
      },
    });
    add(wrap, fileInput);
    add(
      wrap,
      bigButton(
        ticket.photoBusy ? "Processing photo…" : ticket.photoUrl ? "Retake photo" : ticket.hadPhoto ? "Replace photo" : "Take photo of ticket",
        {
          disabled: ticket.photoBusy,
          sub: ticket.photoUrl ? "Photo attached — saves with the ticket" : ticket.hadPhoto ? "A photo is already on file for this haul" : "Optional, but recommended",
          onClick: () => fileInput.click(),
        }
      )
    );
    if (ticket.photoUrl) {
      add(
        wrap,
        h("img", {
          src: ticket.photoUrl,
          alt: "Scale ticket photo preview",
          style: `max-width:100%;max-height:260px;object-fit:contain;border-radius:8px;border:1px solid ${COLORS.border};`,
        })
      );
    }

    add(wrap, errorLine(ticket.error));
    add(wrap, bigButton("Save scale ticket", { tone: "gold", onClick: saveTicket }));
    add(wrap, linkButton("← Back", () => setState({ screen: "haulList" })));
    return wrap;
  }

  async function saveTicket() {
    if (ticket.saving || ticket.photoBusy) return;
    const x = ticket.shipment;
    const gross = num(ticket.gross);
    const tare = num(ticket.tare);
    let net = num(ticket.net);
    if (net == null && gross != null && tare != null) net = gross - tare;
    if (!(net > 0)) {
      ticket.error = "Enter the net weight — or gross and tare so it can be worked out.";
      rerender();
      return;
    }
    const crop = normCrop(x.crop);
    let bushels = num(ticket.bushels);
    const moisture = num(ticket.moisture);
    if (bushels == null && moisture != null && moisture >= 20) {
      // Wet grain: the buyer's net bushels are AFTER moisture shrink, so
      // weight ÷ 56 would overstate the load by a quarter or more.
      ticket.error = `This load is wet (${moisture}% moisture). The buyer's net bushels are after shrink — type the ticket's Net bushels instead of leaving it blank.`;
      rerender();
      return;
    }
    if (bushels == null) bushels = net / (STANDARD_LB_PER_BU[crop] || 56);

    ticket.saving = true;
    try {
      await queueTicket({
        shipmentClientId: x.client_id,
        workerId: state.worker.id,
        ticketNumber: ticket.number.trim(),
        grossLb: gross,
        tareLb: tare,
        netLb: round2(net),
        netBushels: round2(bushels),
        moisturePct: num(ticket.moisture),
        testWeight: num(ticket.testWeight),
        notes: ticket.notes.trim(),
        photo: ticket.photo || null,
        // A correction with no new photo keeps pointing at the earlier one.
        photoPath: ticket.photo ? undefined : ticket.priorPhotoPath,
      });
      await refreshLocal(true);
      haul.done = {
        title: "Scale ticket saved",
        line: `${x.trailer} · ${round2(bushels).toLocaleString()} bu net${ticket.number.trim() ? " · ticket " + ticket.number.trim() : ""}`,
        note: "You can reopen this haul from “Scale tickets” to fix anything — earlier entries are kept on file.",
      };
      if (ticket.photoUrl) URL.revokeObjectURL(ticket.photoUrl);
      ticket.photo = null;
      ticket.photoUrl = null;
      setState({ screen: "haulDone" });
      syncSoon();
    } catch (err) {
      console.error("Could not save ticket", err);
      ticket.error = "Couldn't save the ticket on this device. Try again.";
      rerender();
    } finally {
      ticket.saving = false;
    }
  }

  // How many of the logged-in driver's recent hauls still have no ticket.
  function needsTicketCount() {
    if (!state.worker) return 0;
    return mergedHauls().filter((x) => x.worker_id === state.worker.id && !x.ticket_at).length;
  }

  return {
    refreshLocal,
    needsTicketCount,
    screens: {
      haulTrailer: trailerScreen,
      haulOrigin: originScreen,
      haulField: fieldScreen,
      haulBin: binScreen,
      haulDest: destScreen,
      haulDestNew: destNewScreen,
      haulConfirm: confirmScreen,
      haulDone: doneScreen,
      haulList: listScreen,
      haulTicket: ticketScreen,
    },
  };
}
