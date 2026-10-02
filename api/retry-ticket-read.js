// api/retry-ticket-read.js
// Owner-triggered re-run of the AI ticket reading, for the case where
// the Supabase Storage webhook never fired for a particular photo (or
// fired and failed before read-ticket.js could even log an error row) —
// a one-off delivery miss, not a problem with the ticket itself. Called
// from owner.html's "Retry AI read" button.
//
// Authenticates the caller by their own Supabase session (the same
// login that gets them into owner.html at all) rather than the webhook
// secret — the browser must never hold that secret. Uses the SAME
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / ANTHROPIC_API_KEY env vars
// as read-ticket.js — nothing new to add in Vercel's settings.

const { processTicketPhoto } = require("./read-ticket.js");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const authHeader = req.headers["authorization"] || "";
  const accessToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!accessToken) return res.status(401).json({ error: "missing session token" });

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // Verify this is a real, currently-logged-in owner — not the webhook
  // secret, and not something a page visitor could forge. Supabase's own
  // /auth/v1/user endpoint validates the Bearer token and returns who it
  // belongs to; any non-200 here means the session is invalid or expired.
  // apikey just identifies the project — the service role key (already
  // configured for read-ticket.js) works here exactly like the anon key
  // would, so there's no separate key to add just for this.
  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${accessToken}`, apikey: serviceKey },
  });
  if (!userRes.ok) return res.status(401).json({ error: "invalid or expired session" });

  const path = (req.body || {}).path;
  if (!path || typeof path !== "string") return res.status(400).json({ error: "missing photo path" });

  try {
    const result = await processTicketPhoto("scale-tickets", path);
    return res.status(200).json(result);
  } catch (err) {
    return res.status(err.httpStatus || 500).json({ error: String(err.message || err) });
  }
}
