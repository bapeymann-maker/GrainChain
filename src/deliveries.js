// deliveries.js
// The standalone "Deliveries" page (deliveries.html), meant to be installed
// on drivers' phones as its own app. PIN login -> two big buttons:
//   - Start a haul (bin -> buyer), before leaving the bin
//   - Enter scale ticket (numbers + photo), after unloading
// The screens themselves live in haul.js; this file is the shell around
// them (login, home, top bar, rendering, install prompt).

import { getReference } from "./db.js";
import { createHaul } from "./haul.js";
import { COLORS, HEAD, BODY, h, badge, bigButton, linkButton } from "./ui.js";

const TRUCKS = ["U1", "U2", "U3", "U4", "U5", "U6", "U7", "U8"];
// Bushels assumed for a full trailer — all 8 confirmed at 1000 bu.
const TRUCK_BUSHELS = { U1: 1000, U2: 1000, U3: 1000, U4: 1000, U5: 1000, U6: 1000, U7: 1000, U8: 1000 };

const state = {
  screen: "login",
  pin: "",
  pinError: "",
  worker: null,

  bins: [],
  fields: [],
  workers: [],
  destinations: [],
  recentShipments: [],
  trailerContext: [], // per trailer: newest affidavit + newest recorded use (pre-fills the truck affidavit)
};

let root = null;
let lastScreen = null;
let installPrompt = null; // the browser's deferred "install app" prompt, if it offered one

function setState(patch) {
  Object.assign(state, patch);
  render();
}

const haul = createHaul({ state, setState, h, bigButton, linkButton, badge, COLORS, HEAD, BODY, TRUCKS, TRUCK_BUSHELS });

async function refreshReference() {
  const [bins, fields, workers, destinations, recentShipments, trailerContext] = await Promise.all([
    getReference("bins"),
    getReference("fields"),
    getReference("workers"),
    getReference("destinations"),
    getReference("recent_shipments"),
    getReference("trailer_context"),
  ]);
  Object.assign(state, {
    bins: bins || [],
    fields: fields || [],
    workers: workers || [],
    destinations: destinations || [],
    recentShipments: recentShipments || [],
    trailerContext: trailerContext || [],
  });
  // Background syncs refresh this every ~30s. If someone is mid-typing,
  // update the data quietly instead of re-drawing the screen — a redraw
  // would drop keyboard focus.
  const typing = ["INPUT", "TEXTAREA"].includes(document.activeElement && document.activeElement.tagName);
  await haul.refreshLocal(typing); // re-renders unless typing
}

function logOut() {
  state.worker = null;
  setState({ screen: "login", pin: "" });
}

// ---------- install prompt (Android/desktop Chrome) ----------
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    installPrompt = e;
    if (state.screen === "login") render();
  });
  window.addEventListener("appinstalled", () => {
    installPrompt = null;
    if (state.screen === "login") render();
  });
}
const isStandalone = () =>
  (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || window.navigator.standalone === true;
const isIosBrowser = () => /iphone|ipad|ipod/i.test(window.navigator.userAgent || "") && !isStandalone();

// ---------- screens ----------
function loginScreen() {
  const wrap = h("div", { style: "display:flex;flex-direction:column;gap:20px;margin-top:24px;" });
  wrap.appendChild(
    h("div", { style: "text-align:center;" }, [
      h("div", { style: `${HEAD}font-size:26px;font-weight:700;color:${COLORS.text};margin-bottom:4px;` }, "Deliveries"),
      h("div", { style: `font-size:14px;color:${COLORS.textMuted};` }, "Enter your PIN"),
    ])
  );

  if (state.workers.length === 0) {
    wrap.appendChild(
      h(
        "div",
        { style: `border:1px dashed ${COLORS.border};border-radius:10px;padding:14px;color:${COLORS.textMuted};font-size:13px;text-align:center;` },
        "No worker list on this phone yet — no PIN will work until it has connected to the internet at least once."
      )
    );
  }

  const input = h("input", {
    inputmode: "numeric",
    type: "password",
    autocomplete: "off",
    placeholder: "PIN",
    value: state.pin,
    style: `${BODY}box-sizing:border-box;width:100%;font-size:22px;letter-spacing:6px;text-align:center;padding:14px;border-radius:8px;border:1px solid ${COLORS.border};background:${COLORS.panel};color:${COLORS.text};`,
    oninput: (e) => {
      state.pin = e.target.value.replace(/\D/g, "");
      state.pinError = "";
    },
  });
  const submit = async () => {
    const match = state.workers.find((w) => w.pin === state.pin && w.active !== false);
    if (!match) {
      setState({ pinError: "PIN not recognized. Try again." });
      return;
    }
    state.worker = match;
    state.pin = "";
    state.pinError = "";
    // If the page reloaded mid-ticket-entry (some phones do this when the
    // camera opens), this jumps straight back into that ticket — fields
    // and photo intact — instead of dropping the driver at Home having
    // lost everything. restoreDraftIfAny() calls setState itself when it
    // finds one, so only fall back to Home when there's nothing to recover.
    const recovered = await haul.restoreDraftIfAny();
    if (!recovered) setState({ screen: "home" });
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });

  wrap.appendChild(
    h("div", { style: "display:flex;flex-direction:column;gap:10px;" }, [
      input,
      state.pinError ? h("div", { style: `font-size:13px;color:${COLORS.danger};` }, state.pinError) : null,
      h(
        "button",
        {
          style: `${BODY}font-size:17px;font-weight:700;padding:14px;border-radius:8px;border:1px solid ${COLORS.gold};background:${COLORS.goldDark};color:${COLORS.gold};cursor:pointer;`,
          onclick: submit,
        },
        "Log in"
      ),
    ])
  );

  // Help drivers put this on their home screen.
  if (!isStandalone()) {
    if (installPrompt) {
      wrap.appendChild(
        h("div", { style: "text-align:center;margin-top:8px;" }, [
          linkButton(
            "Install this as an app on your phone",
            async () => {
              const p = installPrompt;
              installPrompt = null;
              p.prompt();
              try {
                await p.userChoice;
              } catch {
                /* ignore */
              }
              render();
            },
            COLORS.gold
          ),
        ])
      );
    } else if (isIosBrowser()) {
      wrap.appendChild(
        h(
          "div",
          { style: `font-size:12px;color:${COLORS.textMuted};text-align:center;margin-top:8px;` },
          "To install on iPhone: tap the Share button, then “Add to Home Screen”."
        )
      );
    }
  }
  return wrap;
}

function homeScreen() {
  const wrap = h("div", { style: "display:flex;flex-direction:column;gap:14px;" });
  const first = (state.worker.name || "").split(" ")[0];
  wrap.appendChild(h("div", { style: `${HEAD}font-size:24px;font-weight:700;color:${COLORS.text};` }, `Hi, ${first}`));

  const n = haul.needsTicketCount();
  wrap.appendChild(
    bigButton("Start a haul", {
      tone: n > 0 ? "default" : "gold",
      sub: "Trailer, bin and destination — do this before you leave the bin",
      onClick: () => haul.beginHaulFlow(),
    })
  );
  wrap.appendChild(
    bigButton("Truck affidavit", {
      sub: "Sign before you load organic or transitional grain — from a field or a bin",
      onClick: () => haul.beginAffidavitFlow(),
    })
  );
  wrap.appendChild(
    bigButton("Enter scale ticket", {
      tone: n > 0 ? "gold" : "default",
      sub: n > 0 ? `${n} of your haul${n === 1 ? "" : "s"} still need${n === 1 ? "s" : ""} a ticket` : "After you've unloaded — ticket numbers and a photo",
      onClick: () => setState({ screen: "haulList" }),
    })
  );
  wrap.appendChild(h("div", { style: "margin-top:8px;" }, [linkButton("Log out", logOut)]));
  return wrap;
}

// ---------- shell ----------
function topBar() {
  const bar = h("div", {
    style: `${BODY}display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 16px;border-bottom:1px solid ${COLORS.border};background:${COLORS.panel};`,
  });
  bar.appendChild(
    h("div", { style: "display:flex;align-items:baseline;gap:8px;" }, [
      h("span", { style: `${HEAD}font-size:18px;font-weight:700;color:${COLORS.gold};letter-spacing:0.5px;` }, "GRAINCHAIN"),
      h("span", { style: `font-size:13px;color:${COLORS.textMuted};` }, "Deliveries"),
    ])
  );
  if (state.worker) {
    bar.appendChild(h("span", { style: `font-size:13px;color:${COLORS.text};` }, state.worker.name));
  }
  return bar;
}

function render() {
  if (!root) return;
  root.innerHTML = "";
  const frame = h("div", { style: `${BODY}background:${COLORS.ink};min-height:100vh;display:flex;flex-direction:column;` });
  frame.appendChild(topBar());

  const body = h("div", {
    style: "flex:1;width:100%;max-width:560px;margin:0 auto;box-sizing:border-box;padding:18px 16px 32px;display:flex;flex-direction:column;gap:16px;",
  });
  const screens = { login: loginScreen, home: homeScreen, ...haul.screens };
  body.appendChild((screens[state.screen] || loginScreen)());
  frame.appendChild(body);
  root.appendChild(frame);

  // On arrival at a new screen: start at the top, except the bin and field
  // lists scroll the previously used one into view.
  if (state.screen !== lastScreen) {
    window.scrollTo(0, 0);
    if (state.screen === "haulBin" || state.screen === "haulField") {
      const sel = root.querySelector('[data-selected="true"]');
      if (sel) sel.scrollIntoView({ block: "center", behavior: "auto" });
    }
  }
  lastScreen = state.screen;
}

export async function mountApp(el) {
  root = el;
  render(); // draw the login screen immediately, don't wait on the network
  await refreshReference();
  await haul.refreshLocal(false);
  window.addEventListener("grainchain:reference-updated", refreshReference);
}
