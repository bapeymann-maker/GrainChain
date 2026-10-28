// api/read-tickets-bulk.js
// Owner page -> "Import tickets": reads ONE uploaded file (a photo, or a PDF
// that may hold many tickets) and returns EVERY ticket on it as a list. It
// saves nothing: the owner page shows the list as a preview, and only what
// the owner confirms is saved.
//
// The file must already be in the scale-tickets bucket under bulk/ (the owner
// page uploads it there first; read-ticket.js ignores that prefix).
//
// Authenticates the caller by their own Supabase session, exactly like
// api/retry-ticket-read.js. Uses the SAME env vars as read-ticket.js
// (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY) — nothing new
// to add in Vercel.

const MODEL = "claude-opus-4-8"; // keep in step with read-ticket.js (forced tool_choice needs this model family)
const MAX_TICKETS = 60;

const TICKET_PROPS = {
  page: { type: ["integer", "null"], description: "PDF page number (1-based) the ticket is on; null for a photo" },
  ticket_number: { type: ["string", "null"], description: "Visible characters only, even if partial" },
  ticket_date: { type: ["string", "null"], description: "As printed, e.g. 10/03/2026" },
  ticket_time: { type: ["string", "null"], description: "Time of the final (second) weighing if two are printed, as printed" },
  commodity: { type: ["string", "null"] },
  buyer_name: { type: ["string", "null"], description: "Only if a buyer/destination is printed" },
  buyer_location: { type: ["string", "null"] },
  gross_lb: { type: ["number", "null"] },
  tare_lb: { type: ["number", "null"] },
  net_lb: { type: ["number", "null"] },
  net_bu: { type: ["number", "null"], description: "Net bushels only if printed" },
  moisture_pct: { type: ["number", "null"] },
  test_weight: { type: ["number", "null"] },
  vehicle_id_printed: { type: ["string", "null"] },
  handwritten_notes: { type: ["string", "null"], description: "Verbatim, exactly as written (field, bin, truck, initials...)" },
  legibility_issues: {
    type: "array",
    description: "One short note per thing you could not confidently read; empty if all clear.",
    items: { type: "string" },
  },
};

const SCHEMA = {
  name: "record_scale_tickets",
  description: "Record every distinct scale ticket found in the file. Use null for anything not legible or not printed — never guess.",
  input_schema: {
    type: "object",
    properties: {
      tickets: { type: "array", items: { type: "object", properties: TICKET_PROPS, required: ["legibility_issues"] } },
    },
    required: ["tickets"],
  },
};

const PROMPT = `You are reading a file that holds one or more grain scale tickets from a farm's own scale: phone photos, scans, or a PDF with a ticket per page (or several per page). Return ONE entry per distinct ticket, in the order they appear. Transcribe only what is printed or written. If a value is covered, cut off or unclear, return null for it and add a short note to that ticket's legibility_issues; never infer a digit. Do not do arithmetic: report the numbers as printed.

- The same ticket printed twice (an original and a copy, or a duplicate page) is ONE ticket — read it once.
- Copy handwritten notes exactly as written into handwritten_notes.
- Weights are in pounds. Report them as plain numbers without commas.
- If the file holds no scale ticket at all, return an empty tickets list.`;

async function readTicketsFromFile(bucketPath, deps = {}) {
  const fetchFn = deps.fetch || fetch;
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const fileRes = await fetchFn(`${supabaseUrl}/storage/v1/object/scale-tickets/${bucketPath}`, {
    headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey },
  });
  if (!fileRes.ok) throw Object.assign(new Error(`Could not download the file (${fileRes.status})`), { httpStatus: 404 });
  const contentType = (fileRes.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const isPdf = contentType === "application/pdf" || /\.pdf$/i.test(bucketPath);
  const mediaType = contentType.startsWith("image/") ? contentType : "image/jpeg";
  const base64 = Buffer.from(await fileRes.arrayBuffer()).toString("base64");
  const fileBlock = isPdf
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } }
    : { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } };

  const aiRes = await fetchFn("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 16000,
      tools: [SCHEMA],
      tool_choice: { type: "tool", name: SCHEMA.name },
      messages: [{ role: "user", content: [fileBlock, { type: "text", text: PROMPT }] }],
    }),
  });
  if (!aiRes.ok) throw new Error(`Claude API error (${aiRes.status}): ${await aiRes.text()}`);
  const aiJson = await aiRes.json();
  const toolUse = (aiJson.content || []).find((b) => b.type === "tool_use");
  if (!toolUse) throw new Error("The reader did not return a structured result");
  if (aiJson.stop_reason === "max_tokens") throw new Error("This file has too many tickets to read at once — split it into smaller files");
  const tickets = Array.isArray(toolUse.input && toolUse.input.tickets) ? toolUse.input.tickets : [];
  if (tickets.length > MAX_TICKETS) throw new Error(`More than ${MAX_TICKETS} tickets in one file — split it into smaller files`);
  return { tickets, isPdf };
}

async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const authHeader = req.headers["authorization"] || "";
  const accessToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!accessToken) return res.status(401).json({ error: "missing session token" });

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, { headers: { Authorization: `Bearer ${accessToken}`, apikey: serviceKey } });
  if (!userRes.ok) return res.status(401).json({ error: "invalid or expired session" });

  const path = (req.body || {}).path;
  // only files the bulk importer uploaded; never an arbitrary bucket path
  if (!path || typeof path !== "string" || !/^bulk\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(path)) {
    return res.status(400).json({ error: "missing or invalid file path" });
  }
  try {
    const result = await readTicketsFromFile(path);
    return res.status(200).json({ ok: true, model: MODEL, ...result });
  } catch (err) {
    return res.status(err.httpStatus || 500).json({ error: String(err.message || err) });
  }
}

module.exports = handler;
module.exports.readTicketsFromFile = readTicketsFromFile;
module.exports.config = { maxDuration: 120 };
