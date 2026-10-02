// api/read-settlement.js
// Owner-triggered: right after a settlement document uploads in
// owner.html, this reads it and extracts whatever scale ticket numbers
// it can find, so the "Eligible loads" list on that settlement can
// highlight the ones that actually belong to it instead of making the
// owner hunt through the list by eye.
//
// Unlike read-ticket.js (a Storage webhook, fired by Supabase itself),
// this is called directly by owner.html right after upload, while the
// owner is still sitting there — so it authenticates with the owner's
// own Supabase session rather than a webhook secret, same as
// retry-ticket-read.js. Uses the same SUPABASE_URL /
// SUPABASE_SERVICE_ROLE_KEY / ANTHROPIC_API_KEY env vars as both of
// those; nothing new to configure.

const MODEL = "claude-opus-4-8";

const SCHEMA = {
  name: "record_settlement_tickets",
  description: "List every scale ticket number that appears on this settlement document.",
  input_schema: {
    type: "object",
    properties: {
      ticket_numbers: {
        type: "array",
        items: { type: "string" },
        description: "Every distinct scale ticket number printed anywhere on the document, exactly as shown. Only include ones you can read with real confidence — omit anything blurry, cut off, or ambiguous rather than guessing.",
      },
    },
    required: ["ticket_numbers"],
  },
};

const PROMPT = `You are reading a grain elevator settlement document. A settlement lists the individual scale tickets being paid out on this statement, usually with a ticket number next to each line item — labeled something like "Ticket #", "Ticket No", "Scale Ticket", or shown unlabeled in its own column. Formats vary a lot between elevators.

Find every distinct ticket number printed anywhere on the document and list them, exactly as printed. Only include numbers you can read with real confidence — skip anything blurry, cut off, or ambiguous rather than guessing at a digit. Do not include any other numbers from the document (dollar amounts, dates, bushel quantities, account or contract numbers, page numbers) — only actual scale ticket numbers. If the document has multiple pages, check all of them. If you genuinely cannot find any ticket numbers, return an empty list rather than guessing.`;

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const authHeader = req.headers["authorization"] || "";
  const accessToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!accessToken) return res.status(401).json({ error: "missing session token" });

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // Same pattern as retry-ticket-read.js: verify the owner's own
  // session is real and current, rather than trusting a secret the
  // browser would have to hold.
  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${accessToken}`, apikey: serviceKey },
  });
  if (!userRes.ok) return res.status(401).json({ error: "invalid or expired session" });

  const { settlementId, path } = req.body || {};
  if (!settlementId || !path) return res.status(400).json({ error: "missing settlementId or path" });

  try {
    // 1. Download the document (service role key bypasses the private
    // bucket's RLS, server-side only — same as read-ticket.js).
    const fileRes = await fetch(`${supabaseUrl}/storage/v1/object/settlements/${path}`, {
      headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey },
    });
    if (!fileRes.ok) throw new Error(`Could not download document (${fileRes.status})`);
    const contentType = fileRes.headers.get("content-type") || "";
    const isPdf = contentType.includes("pdf") || path.toLowerCase().endsWith(".pdf");
    const base64 = Buffer.from(await fileRes.arrayBuffer()).toString("base64");

    // 2. Ask Claude to find the ticket numbers, forced into the schema
    // above. PDFs and images use different content block types.
    const contentBlock = isPdf
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } }
      : { type: "image", source: { type: "base64", media_type: contentType || "image/jpeg", data: base64 } };

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
        messages: [{ role: "user", content: [contentBlock, { type: "text", text: PROMPT }] }],
      }),
    });
    if (!aiRes.ok) throw new Error(`Claude API error (${aiRes.status}): ${await aiRes.text()}`);
    const aiJson = await aiRes.json();
    const toolUse = (aiJson.content || []).find((b) => b.type === "tool_use");
    if (!toolUse) throw new Error("Model did not return a structured reading");
    const ticketNumbers = Array.isArray(toolUse.input.ticket_numbers) ? toolUse.input.ticket_numbers : [];

    // 3. Save straight onto the settlement row — this is an update to
    // an existing row (the settlement was already inserted by the time
    // owner.html calls this), not a new table the way ticket_reads is.
    const saveRes = await fetch(`${supabaseUrl}/rest/v1/settlements?id=eq.${settlementId}`, {
      method: "PATCH",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "content-type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ extracted_ticket_numbers: ticketNumbers }),
    });
    if (!saveRes.ok) throw new Error(`Could not save extracted ticket numbers (${saveRes.status})`);

    return res.status(200).json({ ok: true, ticket_numbers: ticketNumbers });
  } catch (err) {
    console.error("read-settlement error", err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}
