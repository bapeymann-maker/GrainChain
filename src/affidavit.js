// affidavit.js
// The clean-truck affidavit a driver signs on their phone for every organic
// or transitional load (see add-truck-affidavits.sql for what's stored and
// how it's protected). Used by haul.js in two places:
//   - starting a haul from an organic/transitional field or bin
//   - the "Truck affidavit" tile, for loads going from a field to the bins
//     (those are logged later on the kiosk; the owner page pairs the two)
//
// The driver picks ONE of three conditions for the trailer, optionally
// marks how it was cleaned (any combination), and signs with a finger.
// The screen opens pre-filled from that trailer's last affidavit — but the
// signature is always fresh, every load: that's the attestation.

import { EXTERNAL, truckLabel, trailerLabel } from "./ui.js";

export const AFFIDAVIT_STATEMENT =
  "I certify that the trailer identified above, which I am using to haul organic or transitional grain, " +
  "was either last used to haul organic grain, or was inspected and found clean, or was inspected and " +
  "cleaned by the method(s) I have marked, so that it is free of residue from non-organic grain and of " +
  "any prohibited substance. This statement is true and complete to the best of my knowledge.";

export const CONDITIONS = [
  { id: "last_used_organic", label: "Last used for organic" },
  { id: "inspected_clean", label: "Inspected and is clean" },
  { id: "inspected_cleaned", label: "Inspected and cleaned" },
];
export const CLEANING_METHODS = [
  { id: "swept", label: "Swept" },
  { id: "blown", label: "Blown" },
  { id: "washed", label: "Washed" },
];

// Only organic and transitional grain needs one. Conventional (and buffer
// loads, which always count as conventional) don't.
export const needsAffidavit = (status) => status === "organic" || status === "transitional";

const fmtWhen = (iso) =>
  new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

// ---------------------------------------------------------------------
// Fingerprint of the signature image, stored with the affidavit so a
// swapped image can be detected later.
// ---------------------------------------------------------------------
function blobToArrayBuffer(blob) {
  if (blob.arrayBuffer) return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsArrayBuffer(blob);
  });
}
export async function sha256Hex(blob) {
  const digest = await crypto.subtle.digest("SHA-256", await blobToArrayBuffer(blob));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------
// Pre-fill. Two things are worked out for a trailer:
//   - its most recent affidavit (this phone's own, or the server's, whichever
//     is newer) — the condition and cleaning methods carry over
//   - its most recent recorded use (a field load on the kiosk, or a haul)
// If that last use was CONVENTIONAL and came after the last affidavit,
// "last used for organic" is contradicted by the system's own records, so
// nothing is pre-selected and the screen says why. This is the one case
// where copying forward would put a false statement under the driver's
// name; it deliberately goes no further than that (no rules about how
// clean "clean" is — that's the driver's call, and the certifier's).
// ---------------------------------------------------------------------
export function prefillFor(trailer, { localAffidavits = [], context = [], localShipments = [] } = {}) {
  // Every outside trailer is a DIFFERENT physical trailer, all recorded under
  // the one name "External" — so "this trailer's last affidavit" or "its last
  // use" would really be some other trailer's. Never carry anything forward.
  if (trailer === EXTERNAL) return { last: null, use: null, conflict: false, condition: null, methods: [], external: true };
  const ctx = context.find((r) => r.trailer === trailer) || null;

  const candidates = [];
  if (ctx && ctx.aff_signed_at) {
    candidates.push({ signedAt: ctx.aff_signed_at, condition: ctx.aff_condition, methods: ctx.aff_methods || [], truck: ctx.aff_truck || null });
  }
  localAffidavits
    .filter((a) => a.trailer === trailer)
    .forEach((a) => candidates.push({ signedAt: a.signedAt, condition: a.condition, methods: a.cleaningMethods || [], truck: a.truck || null }));
  candidates.sort((a, b) => new Date(b.signedAt) - new Date(a.signedAt));
  const last = candidates[0] || null;

  const uses = [];
  if (ctx && ctx.use_at) uses.push({ at: ctx.use_at, status: ctx.use_status, crop: ctx.use_crop, source: ctx.use_source, truck: ctx.use_truck });
  localShipments
    .filter((s) => s.trailer === trailer)
    .forEach((s) => uses.push({ at: s.departedAt, status: s.originStatus || null, crop: s.crop || null, source: "haul", truck: s.truck || null }));
  uses.sort((a, b) => new Date(b.at) - new Date(a.at));
  const use = uses[0] || null;

  const conflict = !!(use && use.status === "conventional" && (!last || new Date(use.at) > new Date(last.signedAt)));
  return {
    last,
    use,
    conflict,
    condition: !conflict && last ? last.condition : null,
    methods: !conflict && last ? [...last.methods] : [],
  };
}

// ---------------------------------------------------------------------
// Signature pad. Points are stored as fractions of the box, so the drawing
// survives the screen being rebuilt (which happens whenever a button is
// tapped) and any change in size.
// ---------------------------------------------------------------------
export function createSignaturePad() {
  let strokes = []; // each stroke: [{ x, y }, ...] with x and y between 0 and 1
  let canvas = null;
  let g = null;
  let drawing = false;
  const INK = "#14181B";
  const MIN_INK = 0.12; // total pen travel, in box-widths — rules out a stray tap or dot

  const box = () => {
    const r = canvas.getBoundingClientRect();
    return { w: r.width || canvas.width || 300, h: r.height || canvas.height || 150, left: r.left || 0, top: r.top || 0 };
  };
  const clamp = (v) => Math.max(0, Math.min(1, v));

  function paint() {
    if (!canvas || !g) return;
    const { w, h } = box();
    g.fillStyle = "#FFFFFF"; // white, not transparent — prints cleanly
    g.fillRect(0, 0, w, h);
    g.strokeStyle = INK;
    g.lineWidth = 2.4;
    g.lineCap = "round";
    g.lineJoin = "round";
    strokes.forEach((s) => {
      if (!s.length) return;
      g.beginPath();
      g.moveTo(s[0].x * w, s[0].y * h);
      if (s.length === 1) g.lineTo(s[0].x * w + 0.1, s[0].y * h);
      s.slice(1).forEach((p) => g.lineTo(p.x * w, p.y * h));
      g.stroke();
    });
  }

  // Called with a freshly built canvas. Listeners go on right away; sizing
  // waits until it's actually on screen (see fit()).
  function attach(el) {
    canvas = el;
    g = canvas.getContext ? canvas.getContext("2d") : null;
    const pos = (e) => {
      const b = box();
      return { x: clamp((e.clientX - b.left) / b.w), y: clamp((e.clientY - b.top) / b.h) };
    };
    canvas.addEventListener("pointerdown", (e) => {
      if (e.preventDefault) e.preventDefault();
      drawing = true;
      if (canvas.setPointerCapture && e.pointerId != null) {
        try { canvas.setPointerCapture(e.pointerId); } catch { /* not every browser allows it — drawing still works */ }
      }
      strokes.push([pos(e)]);
      paint();
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!drawing) return;
      strokes[strokes.length - 1].push(pos(e));
      paint();
    });
    const end = () => { drawing = false; };
    ["pointerup", "pointercancel", "pointerleave"].forEach((t) => canvas.addEventListener(t, end));
  }

  // Match the drawing surface to its on-screen size (sharp on high-density
  // phone screens), then redraw whatever was already signed.
  function fit() {
    if (!canvas) return;
    const r = canvas.getBoundingClientRect();
    if (r.width > 0 && g) {
      const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
      if (g.setTransform) g.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    paint();
  }

  function hasInk() {
    if (!canvas) return false;
    const { w, h } = box();
    let travel = 0;
    strokes.forEach((s) => {
      for (let i = 1; i < s.length; i++) {
        travel += Math.hypot(s[i].x - s[i - 1].x, ((s[i].y - s[i - 1].y) * h) / w);
      }
    });
    return travel >= MIN_INK;
  }

  function toBlob() {
    return new Promise((resolve, reject) => {
      if (!canvas || !canvas.toBlob) return reject(new Error("No signature pad on screen"));
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't capture the signature"))), "image/png");
    });
  }

  function clear() {
    strokes = [];
    paint();
  }

  return { attach, fit, hasInk, toBlob, clear, reset: () => { strokes = []; }, get strokeCount() { return strokes.length; } };
}

// ---------------------------------------------------------------------
// The signing screen. haul.js hands in its UI helpers via ctx and calls
// begin() with what's being certified and what to do once it's signed.
// ---------------------------------------------------------------------
export function createAffidavit(ctx) {
  const { state, setState, h, bigButton, linkButton, badge, COLORS, HEAD, BODY, getInputs } = ctx;
  const pad = createSignaturePad();
  let session = null;

  const rerender = () => setState({});
  const choiceStyle = (selected) =>
    `${BODY}padding:14px 16px;border-radius:10px;border:1px solid ${selected ? COLORS.gold : COLORS.border};background:${selected ? COLORS.goldDark : COLORS.panelAlt};color:${selected ? COLORS.gold : COLORS.text};font-size:15px;font-weight:600;cursor:pointer;text-align:left;`;

  // base: the fields describing what's certified —
  //   { context, trailer, truck, originType, fieldId, binId, originStatus, crop }
  // summary: { from } the origin as a readable label
  // onSigned(record): called with the finished record once it's signed
  // onBack(): where the Back link goes
  function begin({ base, summary, onSigned, onBack }) {
    const pre = prefillFor(base.trailer, getInputs());
    session = { base, summary, onSigned, onBack, pre, condition: pre.condition, methods: [...pre.methods], error: "", saving: false };
    pad.reset();
  }

  async function submit() {
    if (!session || session.saving) return;
    const fail = (msg) => { session.error = msg; rerender(); };
    if (!session.condition) return fail("Pick the condition of the trailer.");
    if (session.condition === "inspected_cleaned" && session.methods.length === 0) {
      return fail("Pick at least one way it was cleaned — swept, blown, or washed.");
    }
    if (!pad.hasInk()) return fail("Sign in the box before you continue.");
    session.saving = true;
    session.error = "";
    try {
      const signature = await pad.toBlob();
      const signatureSha256 = await sha256Hex(signature);
      await session.onSigned({
        ...session.base,
        workerId: state.worker.id,
        condition: session.condition,
        // always in the same order, so the same choices always read the same
        cleaningMethods: session.condition === "inspected_cleaned" ? CLEANING_METHODS.map((m) => m.id).filter((id) => session.methods.includes(id)) : [],
        statement: AFFIDAVIT_STATEMENT,
        signature,
        signatureSha256,
      });
    } catch (err) {
      console.error("Could not save affidavit", err);
      session.error = "Couldn't save the affidavit on this phone. Try again.";
    } finally {
      session.saving = false;
    }
    rerender();
  }

  function screen() {
    const wrap = h("div", { style: "display:flex;flex-direction:column;gap:14px;" });
    const add = (...kids) => kids.forEach((k) => k && wrap.appendChild(k));
    const label = (t) => h("div", { style: `font-size:13px;color:${COLORS.textMuted};` }, t);

    if (!session) {
      add(
        h("div", { style: `border:1px dashed ${COLORS.border};border-radius:10px;padding:20px;color:${COLORS.textMuted};font-size:13px;text-align:center;` }, "Nothing to sign — start again from Home."),
        linkButton("← Home", () => setState({ screen: "home" }))
      );
      return wrap;
    }
    const s = session;
    add(h("div", { style: `${HEAD}font-size:22px;font-weight:700;color:${COLORS.text};` }, "Truck affidavit"));

    // What's being certified
    const card = h("div", { style: `background:${COLORS.panelAlt};border:1px solid ${COLORS.border};border-radius:10px;padding:14px 16px;display:flex;flex-direction:column;gap:8px;` });
    const row = (k, v) =>
      card.appendChild(
        h("div", { style: "display:flex;justify-content:space-between;gap:12px;" }, [
          h("span", { style: `font-size:13px;color:${COLORS.textMuted};` }, k),
          h("span", { style: `font-size:14px;color:${COLORS.text};text-align:right;` }, v),
        ])
      );
    row("Driver", state.worker.name);
    if (s.base.truck) row("Truck", s.base.truck === EXTERNAL ? truckLabel(EXTERNAL) : `#${s.base.truck}`);
    row("Trailer", trailerLabel(s.base.trailer));
    row("Loading from", s.summary.from);
    if (s.base.crop) row("Crop", s.base.crop);
    card.appendChild(
      h("div", { style: "display:flex;justify-content:space-between;align-items:center;" }, [
        h("span", { style: `font-size:13px;color:${COLORS.textMuted};` }, "Status"),
        badge(s.base.originStatus),
      ])
    );
    add(card);

    // Where the pre-fill came from, and anything the records say against it
    const { last, use, conflict } = s.pre;
    if (s.pre.external) {
      add(h("div", { "data-role": "affidavit-prefill", style: `font-size:12px;color:${COLORS.textMuted};` }, "Outside trailer — each one is different, so nothing is pre-filled. Choose what's true for this one."));
    } else if (conflict) {
      add(
        h(
          "div",
          { "data-role": "affidavit-warning", style: `font-size:13px;color:${COLORS.amber};background:${COLORS.amberDark};border-radius:8px;padding:10px 12px;` },
          `${s.base.trailer} hauled conventional${use.crop ? " " + use.crop.toLowerCase() : ""} on ${fmtWhen(use.at)}${last ? ", after its last affidavit" : ""}. Nothing is pre-selected — pick what's true today.`
        )
      );
    } else if (last) {
      add(
        h(
          "div",
          { "data-role": "affidavit-prefill", style: `font-size:12px;color:${COLORS.textMuted};` },
          `Pre-filled from ${s.base.trailer}'s last affidavit (${fmtWhen(last.signedAt)}${last.truck ? ", Truck " + last.truck : ""}). Change anything that's different now.`
        )
      );
    } else {
      add(h("div", { "data-role": "affidavit-prefill", style: `font-size:12px;color:${COLORS.textMuted};` }, `No earlier affidavit on record for ${s.base.trailer} — choose below.`));
    }
    if (use && !conflict) {
      add(
        h(
          "div",
          { style: `font-size:12px;color:${COLORS.textMuted};margin-top:-8px;` },
          `Last recorded use of ${s.base.trailer}: ${[use.status, use.crop && use.crop.toLowerCase()].filter(Boolean).join(" ") || "no status on record"} · ${fmtWhen(use.at)} (${use.source === "load" ? "field load" : "haul"})`
        )
      );
    }

    // Condition — pick one
    add(label("Condition of the trailer"));
    CONDITIONS.forEach((c) =>
      add(
        h(
          "button",
          {
            "data-condition": c.id,
            "data-selected": s.condition === c.id ? "true" : null,
            style: choiceStyle(s.condition === c.id),
            onclick: () => { s.condition = c.id; s.error = ""; rerender(); },
          },
          c.label
        )
      )
    );

    // How it was cleaned — any combination, only when it was cleaned
    if (s.condition === "inspected_cleaned") {
      add(label("How was it cleaned? Pick all that apply."));
      const grid = h("div", { style: "display:grid;grid-template-columns:repeat(3,1fr);gap:8px;" });
      CLEANING_METHODS.forEach((m) => {
        const on = s.methods.includes(m.id);
        grid.appendChild(
          h(
            "button",
            {
              "data-method": m.id,
              "data-selected": on ? "true" : null,
              style: `${choiceStyle(on)}text-align:center;padding:14px 8px;`,
              onclick: () => {
                s.methods = on ? s.methods.filter((x) => x !== m.id) : [...s.methods, m.id];
                s.error = "";
                rerender();
              },
            },
            (on ? "✓ " : "") + m.label
          )
        );
      });
      add(grid);
    }

    // The statement they're signing
    add(
      h("div", { style: `font-size:12px;line-height:1.45;color:${COLORS.textMuted};border-left:2px solid ${COLORS.border};padding-left:10px;` }, AFFIDAVIT_STATEMENT)
    );

    // Signature
    add(label("Sign with your finger"));
    const holder = h("div", { style: "position:relative;" });
    const canvas = h("canvas", {
      "data-role": "signature-pad",
      style: "display:block;width:100%;height:170px;background:#FFFFFF;border-radius:8px;touch-action:none;",
    });
    pad.attach(canvas);
    holder.appendChild(canvas);
    // A guide line to sign on. It's a separate layer, so it never ends up in the saved image.
    holder.appendChild(
      h("div", { style: "position:absolute;left:14px;right:14px;bottom:30px;border-bottom:1px solid #B5B9BD;pointer-events:none;" }, [
        h("span", { style: "position:absolute;left:0;bottom:2px;font-size:16px;color:#8A9096;" }, "✕"),
      ])
    );
    add(holder);
    // Sized once it's actually in the page.
    Promise.resolve().then(() => pad.fit());
    add(h("div", { style: "display:flex;justify-content:flex-end;margin-top:-6px;" }, [linkButton("Clear signature", () => { pad.clear(); s.error = ""; })]));

    if (s.error) add(h("div", { "data-role": "affidavit-error", style: `font-size:13px;color:${COLORS.danger};` }, s.error));
    add(bigButton("Sign and continue", { tone: "gold", onClick: submit }));
    add(linkButton("← Back", () => s.onBack()));
    return wrap;
  }

  return { begin, screen };
}
