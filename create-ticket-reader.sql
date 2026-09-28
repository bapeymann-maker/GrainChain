-- GrainChain: AI reading of scale ticket photos.
-- Run in the Supabase SQL Editor, after create-outbound-hauls.sql.

-- ---------------------------------------------------------------
-- One row per photo read. Never touches what the driver typed —
-- owner.html shows the two side by side and flags disagreements.
-- No RLS policies for anon or authenticated on INSERT: only the
-- reader function (using the service role key, which bypasses RLS
-- entirely) can write here. authenticated gets read-only SELECT.
-- ---------------------------------------------------------------
create table if not exists ticket_reads (
  id bigint generated always as identity primary key,
  shipment_client_id uuid,
  ticket_client_id uuid,
  photo_path text not null,
  read_at timestamptz not null default now(),
  model text,

  buyer_name text,
  buyer_location text,
  ticket_number text,
  ticket_number_complete boolean,
  ticket_date text,
  direction text,
  commodity text,

  gross_lb numeric,
  tare_lb numeric,
  net_lb numeric,
  gross_time text,
  tare_time text,

  gross_bu numeric,
  shrink_bu numeric,
  net_bu numeric,

  moisture_pct numeric,
  test_weight numeric,
  foreign_material_pct numeric,
  damage_pct numeric,
  heat_damage_pct numeric,

  vehicle_id_printed text,
  bol text,
  owner_splits jsonb,
  handwritten_notes text,
  cleaning_affidavit jsonb,
  legibility_issues text[],

  arithmetic_check text,          -- 'pass' or 'fail: <reason>'
  needs_review boolean not null default true,
  raw_response jsonb,             -- full model output, for debugging a bad read
  error text                      -- set if the read itself failed (bad image, API error, ...)
);

alter table ticket_reads enable row level security;
create policy "Owner can read ticket reads" on ticket_reads for select to authenticated using (true);
grant select on public.ticket_reads to authenticated;

-- ---------------------------------------------------------------
-- Fires the reader function on every new scale ticket photo.
--
-- Before running this: replace both placeholders below —
--   YOUR-VERCEL-URL      -> your real deployment URL
--   YOUR-WEBHOOK-SECRET  -> a random string you make up (e.g. run
--     `openssl rand -hex 24` locally, or just mash the keyboard).
--     Use the SAME string as WEBHOOK_SECRET in Vercel's env vars —
--     it's how the function knows a request really came from here
--     and not from anyone who finds the URL.
-- ---------------------------------------------------------------
create trigger "on_scale_ticket_uploaded"
after insert on storage.objects
for each row
when (new.bucket_id = 'scale-tickets')
execute function supabase_functions.http_request(
  'https://YOUR-VERCEL-URL/api/read-ticket',
  'POST',
  '{"Content-Type":"application/json","x-webhook-secret":"YOUR-WEBHOOK-SECRET"}',
  '{}',
  '15000'
);
