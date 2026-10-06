// updates.js
// A phone can keep running an old copy of the app for a while after a new one
// is published (a Home Screen app on iPhone especially): the new files arrive
// in the background, but the page already on screen keeps the old ones until
// it's reloaded. This notices when that has happened and offers a reload —
// never forces one, since a driver may be partway through typing a ticket.

// Calls show() when a NEWER copy of the app takes over from the one this page
// was loaded with. Not on a first-ever install: with no earlier copy there's
// nothing old to be running.
export function watchForUpdates({ serviceWorker = typeof navigator !== "undefined" ? navigator.serviceWorker : null, show }) {
  if (!serviceWorker) return;
  const hadController = !!serviceWorker.controller;
  serviceWorker.addEventListener("controllerchange", () => {
    if (hadController) show();
  });
}

export function showUpdateBanner(doc = document, reload = () => location.reload()) {
  if (doc.getElementById("update-banner")) return;
  const bar = doc.createElement("div");
  bar.id = "update-banner";
  bar.setAttribute("role", "status");
  bar.style.cssText =
    "position:fixed;top:0;left:0;right:0;z-index:9999;background:#3A2F0E;color:#D4A017;border-bottom:1px solid #D4A017;padding:12px 16px;font:600 14px -apple-system,system-ui,sans-serif;display:flex;gap:12px;align-items:center;justify-content:space-between;";
  const msg = doc.createElement("span");
  msg.textContent = "A new version is ready. Finish what you're entering, then reload.";
  const btn = doc.createElement("button");
  btn.textContent = "Reload";
  btn.style.cssText = "background:#D4A017;color:#14181B;border:0;border-radius:8px;padding:8px 14px;font-weight:700;font-size:14px;";
  btn.addEventListener("click", reload);
  bar.appendChild(msg);
  bar.appendChild(btn);
  doc.body.appendChild(bar);
}
