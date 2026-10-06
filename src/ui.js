// ui.js
// Small framework-free UI helpers for the standalone Deliveries page.
// Copied from app.js (the dryer-shed kiosk) so the two pages look and
// behave alike, without the Deliveries page depending on kiosk internals.
// h() builds DOM with textContent only — never innerHTML with real data —
// so names coming from Supabase can't break rendering or inject markup.

export const COLORS = {
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
export const HEAD = "font-family:'Bahnschrift','DIN Alternate','Arial Narrow',sans-serif;";
export const BODY = "font-family:Inter,-apple-system,'Segoe UI',sans-serif;";

// The version of the app code, shown at the bottom of the Deliveries screen so
// anyone can see what a phone is actually running (a Home Screen app on iPhone
// can hold on to an old copy). Keep it equal to the number in sw.js's
// CACHE_NAME — bump both together; the test suite checks they match.
export const APP_VERSION = "32";

// Hauls by outside drivers use their own truck and trailer, which have no
// number of ours. They're stored as the literal text "External" in the same
// truck / trailer columns (no schema change) and shown in plain words.
export const EXTERNAL = "External";
export const truckLabel = (t) => (t === EXTERNAL ? "External truck" : `Truck ${t}`);
export const trailerLabel = (t) => (t === EXTERNAL ? "External trailer" : t);
export const rigText = (truck, trailer) => (truck ? `${truckLabel(truck)} · ${trailerLabel(trailer)}` : trailerLabel(trailer));

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
export function h(tag, props = {}, children = []) {
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

export function badge(status) {
  const s = STATUS_LABEL[status];
  if (!s) return h("span");
  return h(
    "span",
    { style: `${BODY}font-size:12px;font-weight:700;color:${s.fg};background:${s.bg};padding:4px 10px;border-radius:999px;white-space:nowrap;` },
    s.label
  );
}

export function bigButton(label, { onClick, tone = "default", sub, disabled = false } = {}) {
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

export function linkButton(label, onClick, color = COLORS.textMuted) {
  return h(
    "button",
    { style: `${BODY}font-size:13px;color:${color};background:none;border:none;cursor:pointer;`, onclick: onClick },
    label
  );
}
