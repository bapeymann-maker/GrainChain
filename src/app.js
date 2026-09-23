// app.js
// Placeholder mount point. This is where the kiosk UI (login, field, truck,
// bin, confirm — the flow already prototyped in kiosk-prototype.jsx) gets
// ported in and wired to queueLoad() from db.js instead of React state.
//
// The pattern for every screen stays the same regardless of UI framework:
//   1. Read reference data from getReference("fields") / getReference("bins")
//      — populated by sync.js, works offline once cached once.
//   2. On "Log this load", call queueLoad({...}) from db.js. That resolves
//      instantly and locally — no network wait, no spinner.
//   3. sync.js pushes it to Supabase in the background whenever the
//      Chromebook has a connection.

import { queueLoad, getReference } from "./db.js";

export async function mountApp(root) {
  const fields = (await getReference("fields")) || [];

  root.innerHTML = `
    <div style="font-family: Inter, system-ui, sans-serif; color: #F4F1E9; padding: 24px;">
      <h1 style="color:#D4A017; font-size: 20px;">Grain Kiosk — offline-first shell</h1>
      <p style="color:#9AA2A8; font-size: 14px; max-width: 480px;">
        Reference data cached locally: ${fields.length} field(s).
        Port the kiosk-prototype.jsx flow in here, swapping its in-memory
        state for calls into db.js. See db.js and sync.js for the storage
        and sync contract.
      </p>
    </div>
  `;
}

// Example of the shape a real "Log this load" handler passes to queueLoad —
// kept here as a reference for wiring up the ported UI.
export async function exampleLogLoad() {
  await queueLoad({
    workerId: "w1",
    fieldId: "c1",
    truck: "3",
    truckMode: "full",
    bushels: 1000,
    weightLb: null,
    moisturePct: null,
    testWeight: null,
    binId: "b1",
    isBuffer: false,
  });
}
