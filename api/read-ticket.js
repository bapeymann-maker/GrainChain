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

const MODEL = "claude-opus-5-5"; // accuracy matters here (money, audit trail); swap for claude-sonnet-5-5 if cost matters more than squeezing out the last bit of accuracy
const STANDARD_LB_PER_BU = { corn: 56, soybeans: 60, oats: 32 };

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
      legibility_issues: { type: "array", items: { type: "string" } },
    },
    required: ["legibility_issues"],
  },
};

const PROMPT = `You are reading a photo of a grain scale ticket taken by a truck driver. The photo may be rotated, angled, partly covered by a clipboard clip or fingers, or show the same ticket printed twice (original and copy) — read it once. Transcribe only what is actually printed or written. If a value is covered, cut off, or unclear, return null for it and add a short note to legibility_issues; never infer a digit. For ticket_number, return the visible characters and set ticket_number_complete to false if any part is hidden. Copy handwritten notes exactly as written. Do not perform any arithmetic yourself — report the numbers as printed. If the photo does not contain a scale ticket at all, return null for every field and say so in legibility_issues.`;

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  if (req.headers["x-webhook-secret"] !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: "bad webhook secret" });
  }

  const body = req.body || {};
  // Accept either the Supabase webhook payload shape, or a plain
  // {bucket, path} body for manually re-running a read (e.g. backfilling
  // a photo that was uploaded before this was wired up).
  const bucket = body.record?.bucket_id || body.bucket;
  const path = body.record?.name || body.path;
  if (bucket !== "scale-tickets" || !path) {
    return res.status(200).json({ skipped: true, reason: "not a scale-tickets photo" });
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
    if (Array.isArray(read.owner_splits) && read.owner_splits.length && read.net_lb != null) {
      const sum = read.owner_splits.reduce((s, o) => s + (o.net_lb || 0), 0);
      if (!near(sum, read.net_lb, 1)) problems.push(`owner_splits sum ${sum} != net_lb ${read.net_lb}`);
    }
    if ((read.legibility_issues || []).length) problems.push(`legibility: ${read.legibility_issues.join("; ")}`);

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
    return res.status(500).json({ error: "could not save reading" });
  }

  return res.status(200).json({ ok: true, needs_review: record.needs_review });
}
