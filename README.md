# Ufer Farms Grain Kiosk — offline-first PWA scaffold

## Why this shape

The kiosks are Chromebooks logging in with a PIN, running at sites that
can't be trusted to have internet. So the design rule is: **every write
happens locally first, and syncs to Supabase opportunistically.** The
kiosk never blocks on a network call to log a load.

- `src/db.js` — IndexedDB wrapper. `queueLoad()` writes a load locally and
  returns immediately. `getReference()` / `cacheReference()` hold a local
  copy of fields, bins, and affidavit status so the kiosk works even if
  it's never seen the internet that day.
- `src/sync.js` — runs whenever the Chromebook is online (on the `online`
  event, plus a 30s poll as a backstop): pushes anything queued in
  `pending_loads` up to Supabase, and refreshes the local reference-data
  cache. One failed record never blocks the rest of the queue.
- `sw.js` — service worker that caches the app shell itself, so the kiosk
  can launch fullscreen with zero connectivity, not just log data offline.
- `src/app.js` — placeholder mount point. **Not done yet** — this is where
  the kiosk-prototype.jsx flow (login → field → truck → bin → confirm)
  gets ported in, calling `queueLoad()` on submit instead of holding
  everything in React state.

## Why not Electron/Tauri

Chromebooks run ChromeOS. A native desktop app would need the Linux
(Crostini) container enabled and sideloaded per device — awkward to
manage at scale and not how ChromeOS kiosks are normally deployed. A PWA
launched via ChromeOS's built-in kiosk mode is the standard, supported
path and needs nothing installed beyond Chrome itself.

## Deploying to the Chromebooks

1. Host these files somewhere with HTTPS (this can be the same Vercel
   project pattern used for FieldOpsManager/Train Ticket System).
2. In the Google Admin console: **Devices → Chrome → Apps & Extensions →
   Kiosks**, add this as a **Web app**, pointing at the hosted
   `index.html` URL.
3. Assign that kiosk to the device(s) via an OU or device policy. The
   Chromebook then boots straight into this app, fullscreen, no login
   screen of its own — matches the individual-login-inside-the-app model
   already decided (worker PIN, not a shared device login).

## Wiring up real Supabase

Replace the placeholder values in `index.html`:
```js
initSync({
  supabaseUrl: "https://YOUR-PROJECT.supabase.co",
  supabaseAnonKey: "YOUR-ANON-KEY",
  onStatusChange: renderStatus,
});
```
And create a `loads` table in Supabase with a unique constraint on
`client_id` (used for de-dupe if a sync retry double-POSTs a record) —
see the row shape in `sync.js`'s `toLoadRow()`.

**Important:** blend-share math (proportional field composition per bin)
should be computed in Supabase after sync, not on the kiosk. Two kiosks
writing to the same bin offline, at the same time, could disagree if the
blend math ran locally on each device — keeping it server-side avoids
that entirely.

## Still open

- Dickey-John moisture tester integration: Chrome supports the **Web
  Serial API**, which is the likely path if the tester exposes a
  serial/USB-serial interface — still pending confirming its actual
  export format/protocol.
- The `pending_loads` → `loads` table schema above is a starting point,
  not final — line up with the bookkeeper's chart of accounts work before
  treating it as fixed.
