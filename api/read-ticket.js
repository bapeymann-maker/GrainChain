// api/read-ticket.js
// Called by the Supabase database webhook whenever a photo lands in the
// scale-tickets bucket (see create-ticket-reader.sql). Downloads the
// photo, asks Claude to transcribe it into a fixed schema, checks the
// arithmetic, and saves the result to ticket_reads — never touching
// what the driver typed in the app.
//
// Vercel env vars required (Project Settings -> Environment Variables):
//   SUPABASE_URL               same project URL as the app
//   SUPABASE_SERVICE_ROLE_KEY  Project Settings -> API -> service_role
//                               (NOT the anon key — this one bypasses
//                               RLS, which is what a backend needs to
//                               read the private bucket and write
//                               ticket_reads. Never put it in the app.)
//   ANTHROPIC_API_KEY          from console.anthropic.com
//   WEBHOOK_SECRET             any random string; must match the one
//                               baked into the trigger in
//                               create-ticket-reader.sql

const MODEL = "claude-opus-4-8"; // opus-5-5/sonnet-5-5 don't support forced tool_choice (adaptive thinking is always on for them) — 4-8 does, and is still strong for reading a photo
const STANDARD_LB_PER_BU = { corn: 56, soybeans: 60, oats: 32 };

// Every field a legibility issue can be tagged against. Keeping this list
// in sync with owner.html's DETAIL_FIELDS `key`s is what lets the review
// UI prompt for a correction on the SPECIFIC field that was flagged,
// instead of guessing from free-text wording.
const FIELD_KEYS = [
  "ticket_number", "buyer", "ticket_date", "commodity",
  "gross_lb", "tare_lb", "net_lb", "gross_time", "tare_time",
  "gross_bu", "shrink_bu", "net_bu",
  "moisture_pct", "test_weight", "foreign_material_pct", "damage_pct", "heat_damage_pct",
  "vehicle_id_printed", "bol", "owner_splits", "handwritten_notes",
  "other", // doesn't map to a specific field (e.g. "not a scale ticket at all")
];

const SCHEMA = {
  name: "record_scale_ticket",
  description: "Record every field read from the scale ticket photo. Use null for anything not legible or not printed — never guess.",
  input_schema: {
    type: "object",
    properties: {
      buyer_name: { type: ["string", "null"] },
      buyer_location: { type: ["string", "null"] },
      ticket_number: { type: ["string", "null"], description: "Visible characters only, even if partial" },
      ticket_number_complete: { type: ["boolean", "null"], description: "false if any part of the number is covered/cut off" },
      ticket_date: { type: ["string", "null"] },
      direction: { type: ["string", "null"], description: "e.g. INBOUND" },
      commodity: { type: ["string", "null"] },
      gross_lb: { type: ["number", "null"] },
      tare_lb: { type: ["number", "null"] },
      net_lb: { type: ["number", "null"] },
      gross_time: { type: ["string", "null"] },
      tare_time: { type: ["string", "null"] },
      gross_bu: { type: ["number", "null"] },
      shrink_bu: { type: ["number", "null"] },
      net_bu: { type: ["number", "null"] },
      moisture_pct: { type: ["number", "null"] },
      test_weight: { type: ["number", "null"] },
      foreign_material_pct: { type: ["number", "null"] },
      damage_pct: { type: ["number", "null"] },
      heat_damage_pct: { type: ["number", "null"] },
      vehicle_id_printed: { type: ["string", "null"] },
      bol: { type: ["string", "null"] },
      owner_splits: {
        type: ["array", "null"],
        items: {
          type: "object",
          properties: { name: { type: "string" }, pct: { type: ["number", "null"] }, net_lb: { type: ["number", "null"] }, net_bu: { type: ["number", "null"] } },
        },
      },
      handwritten_notes: { type: ["string", "null"], description: "Verbatim, exactly as written" },
      cleaning_affidavit: {
        type: ["object", "null"],
        properties: { present: { type: "boolean" }, date_filled: { type: ["string", "null"] }, signed: { type: ["boolean", "null"] } },
      },
      legibility_issues: {
        type: "array",
        description: "One entry per distinct thing you could not confidently read.",
        items: {
          type: "object",
          properties: {
            field: { type: "string", enum: FIELD_KEYS, description: "The ONE field this issue concerns. Use \"other\" only if it genuinely doesn't map to any field above." },
            note: { type: "string", description: "Short reason — e.g. 'covered by clip', 'cut off at right edge', 'blurry'." },
          },
          required: ["field", "note"],
        },
      },
    },
    required: ["legibility_issues"],
  },
};

const PROMPT = `You are reading a photo of a grain scale ticket taken by a truck driver. Transcribe only what is actually printed or written. If a value is covered, cut off, or genuinely unclear, return null for it and add an entry to legibility_issues naming the ONE field it concerns and a short reason; never infer a digit. For ticket_number, return the visible characters and set ticket_number_complete to false if any part is hidden.

legibility_issues is ONLY for things you could not confidently read — leave it empty otherwise. It is not a place for routine observations. In particular:
- The photo may be rotated or angled, may be partly covered by a clipboard clip or fingers, and some buyers (Valero in particular) routinely print two copies of the same ticket on one page. All of this is normal. If both copies are legible, silently read from whichever is clearer — do not mention that there were two copies.
- Tickets often carry fields with no home in the schema below (an account number, a carrier name, a contract type, etc.). Ignore anything that doesn't fit a field; do not note its absence.
- Each legibility_issues entry concerns exactly ONE field. If a section of the ticket has several unreadable numbers, add one entry per field (e.g. separate entries for buyer and gross_lb), not one entry describing the whole area.

Copy handwritten notes exactly as written into handwritten_notes. Do not perform any arithmetic yourself — report the numbers as printed. If the photo does not contain a scale ticket at all, return null for every field and add one legibility_issues entry with field "other" saying so.`;

// The actual read-a-photo-and-save-a-row work, shared by the webhook
// handler below and by api/retry-ticket-read.js (an authenticated,
// owner-triggered path for re-running a read that never happened the
// first time — a missed or failed webhook delivery, not a problem with
// the ticket itself). Both callers already know the caller is
// legitimate by the time this runs; this function itself does no auth.
async function processTicketPhoto(bucket, path) {
  if (bucket !== "scale-tickets" || !path) {
    return { skipped: true, reason: "not a scale-tickets photo" };
  }

  // The upload path is <shipmentClientId>/<ticketClientId>.jpg (see
  // db.js's queueTicket) — both ids come straight from the path, no
  // guessing which haul/ticket this photo belongs to.
  const [shipmentClientId, fileName] = path.split("/");
  const ticketClientId = (fileName || "").replace(/\.[a-z0-9]+$/i, "");

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const record = {
    shipment_client_id: shipmentClientId || null,
    ticket_client_id: ticketClientId || null,
    photo_path: path,
    model: MODEL,
  };

  try {
    // 1. Download the photo (service role key bypasses the bucket's
    // private RLS — that's the point of using it here, server-side only).
    const imgRes = await fetch(`${supabaseUrl}/storage/v1/object/scale-tickets/${path}`, {
      headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey },
    });
    if (!imgRes.ok) throw new Error(`Could not download photo (${imgRes.status})`);
    const mediaType = imgRes.headers.get("content-type") || "image/jpeg";
    const base64 = Buffer.from(await imgRes.arrayBuffer()).toString("base64");

    // 2. Ask Claude to transcribe it, forced into the schema above.
    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2000,
        tools: [SCHEMA],
        tool_choice: { type: "tool", name: SCHEMA.name },
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
              { type: "text", text: PROMPT },
            ],
          },
        ],
      }),
    });
    if (!aiRes.ok) throw new Error(`Claude API error (${aiRes.status}): ${await aiRes.text()}`);
    const aiJson = await aiRes.json();
    const toolUse = (aiJson.content || []).find((b) => b.type === "tool_use");
    if (!toolUse) throw new Error("Model did not return a structured reading");
    const read = toolUse.input;

    // 3. Check the printed numbers agree with each other. This never
    // corrects anything — it only decides whether the row needs a human.
    const commodityKey = (read.commodity || "").toLowerCase().includes("soy")
      ? "soybeans"
      : (read.commodity || "").toLowerCase().includes("oat")
      ? "oats"
      : "corn";
    const factor = STANDARD_LB_PER_BU[commodityKey];
    const problems = [];
    const near = (a, b, tol) => a != null && b != null && Math.abs(a - b) <= tol;

    if (read.gross_lb != null && read.tare_lb != null && read.net_lb != null && !near(read.net_lb, read.gross_lb - read.tare_lb, 1)) {
      problems.push(`net_lb ${read.net_lb} != gross-tare ${read.gross_lb - read.tare_lb}`);
    }
    if (read.net_lb != null && read.gross_bu != null && !near(read.gross_bu, read.net_lb / factor, 0.5)) {
      problems.push(`gross_bu ${read.gross_bu} vs net_lb/${factor} = ${(read.net_lb / factor).toFixed(2)}`);
    }
    if (read.gross_bu != null && read.shrink_bu != null && read.net_bu != null && !near(read.net_bu, read.gross_bu - read.shrink_bu, 0.5)) {
      problems.push(`net_bu ${read.net_bu} vs gross-shrink = ${(read.gross_bu - read.shrink_bu).toFixed(2)}`);
    }
    if (Array.isArray(read.owner_splits) && read.owner_splits.length) {
      // Tickets print splits in whichever unit they use — some show lb per
      // owner, some (most single-owner Meuret tickets) show only bushels
      // under "Net Units". Only check the unit that's ACTUALLY populated
      // on every split; a split missing that unit isn't "0", it's just not
      // printed that way, so summing it as 0 would false-flag almost every
      // single-owner ticket.
      const n = read.owner_splits.length;
      const lbVals = read.owner_splits.map((o) => o.net_lb).filter((v) => v != null);
      const buVals = read.owner_splits.map((o) => o.net_bu).filter((v) => v != null);
      if (lbVals.length === n && read.net_lb != null) {
        const sum = lbVals.reduce((a, b) => a + b, 0);
        if (!near(sum, read.net_lb, 1)) problems.push(`owner_splits (lb) sum ${sum} != net_lb ${read.net_lb}`);
      } else if (buVals.length === n && read.net_bu != null) {
        const sum = buVals.reduce((a, b) => a + b, 0);
        if (!near(sum, read.net_bu, 0.5)) problems.push(`owner_splits (bu) sum ${sum} != net_bu ${read.net_bu}`);
      }
      // Otherwise (mixed or missing units across splits): nothing reliable
      // to check against — skip rather than guess.
    }
    if ((read.legibility_issues || []).length) problems.push(`legibility: ${read.legibility_issues.map((i) => `${i.field}: ${i.note}`).join("; ")}`);

    Object.assign(record, read, {
      arithmetic_check: problems.length ? `fail: ${problems.join(" | ")}` : "pass",
      needs_review: problems.length > 0,
      raw_response: aiJson,
    });
  } catch (err) {
    console.error("read-ticket error", err);
    record.error = String(err.message || err);
    record.needs_review = true;
  }

  // 4. Save the reading (service role key — this table has no insert
  // policy for anyone else, by design; see create-ticket-reader.sql).
  const saveRes = await fetch(`${supabaseUrl}/rest/v1/ticket_reads`, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "content-type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(record),
  });
  if (!saveRes.ok) {
    console.error("Could not save ticket_reads row", saveRes.status, await saveRes.text());
    const err = new Error("could not save reading");
    err.httpStatus = 500;
    throw err;
  }

  return { ok: true, needs_review: record.needs_review };
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  if (req.headers["x-webhook-secret"] !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: "bad webhook secret" });
  }

  const body = req.body || {};
  // Accept either the Supabase webhook payload shape, or a plain
  // {bucket, path} body for manually re-running a read.
  const bucket = body.record?.bucket_id || body.bucket;
  const path = body.record?.name || body.path;

  try {
    const result = await processTicketPhoto(bucket, path);
    if (result.skipped) return res.status(200).json(result);
    return res.status(200).json(result);
  } catch (err) {
    return res.status(err.httpStatus || 500).json({ error: String(err.message || err) });
  }
}

module.exports.processTicketPhoto = processTicketPhoto;
