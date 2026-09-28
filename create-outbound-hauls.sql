-- GrainChain: outbound hauls (bin -> buyer) with scale tickets + photos.
-- Run once in the Supabase SQL Editor. Safe to re-run.

-- ---------------------------------------------------------------
-- Where grain is sold to. Add more rows as buyers come up.
-- ---------------------------------------------------------------
create table if not exists destinations (
  id text primary key,
  name text not null,
  location text,
  active boolean not null default true
);

insert into destinations (id, name, location) values
  ('valero-welcome',     'Valero',                 'Welcome, MN'),
  ('valero-hartley',     'Valero',                 'Hartley, IA'),
  ('meuret-dakota-city', 'J.E. Meuret Grain Co.',  'Dakota City, NE'),
  ('pf-mn-fairmont',     'PF MN Fairmont',         'Fairmont, MN')
on conflict (id) do nothing;

-- ---------------------------------------------------------------
-- A haul leaving a bin. Insert-only from the kiosk/phones, same as loads.
-- ---------------------------------------------------------------
create table if not exists shipments (
  id bigint generated always as identity primary key,
  client_id uuid not null unique,
  departed_at timestamptz not null,
  worker_id text not null references workers(id),
  trailer text not null,
  bin_id text references bins(id),
  crop text,
  bin_status text,               -- organic / transitional / conventional, as of departure
  destination_id text references destinations(id),
  est_bushels numeric,           -- the "temporary" figure entered at departure
  est_weight_lb numeric,
  device_id text
);

-- Hauls can start from a bin OR straight from a field. Safe on a fresh
-- install and on one where the table already exists.
alter table shipments add column if not exists origin_type text not null default 'bin'
  check (origin_type in ('bin', 'field'));
alter table shipments add column if not exists field_id text references fields(id);
alter table shipments add column if not exists origin_status text;   -- organic / transitional / conventional, of the bin or field at departure

-- Truck (tractor) number, separate from the trailer (U1-U8).
alter table shipments add column if not exists truck text;
-- A destination the driver typed because it isn't in the destinations list
-- yet (destination_id stays empty for these). To make one a permanent choice,
-- add it to the destinations table.
alter table shipments add column if not exists destination_name text;
alter table shipments add column if not exists destination_location text;

-- ---------------------------------------------------------------
-- Scale ticket data. APPEND-ONLY: fixing a typo adds a new row and the
-- newest one wins, so every earlier entry stays on file for audit.
-- ---------------------------------------------------------------
create table if not exists shipment_tickets (
  id bigint generated always as identity primary key,
  client_id uuid not null unique,
  shipment_client_id uuid not null references shipments(client_id),
  created_at timestamptz not null,
  worker_id text references workers(id),
  ticket_number text,
  gross_lb numeric,
  tare_lb numeric,
  net_lb numeric,
  net_bushels numeric,
  moisture_pct numeric,
  test_weight numeric,
  photo_path text,               -- path inside the scale-tickets storage bucket
  notes text,
  device_id text
);

-- ---------------------------------------------------------------
-- Row level security + grants
-- ---------------------------------------------------------------
alter table destinations enable row level security;
alter table shipments enable row level security;
alter table shipment_tickets enable row level security;

drop policy if exists "Kiosk can read destinations" on destinations;
create policy "Kiosk can read destinations" on destinations for select to anon using (true);
drop policy if exists "Owner can read destinations" on destinations;
create policy "Owner can read destinations" on destinations for select to authenticated using (true);
grant select on public.destinations to anon, authenticated;

drop policy if exists "Kiosk can insert shipments" on shipments;
create policy "Kiosk can insert shipments" on shipments for insert to anon with check (true);
drop policy if exists "Owner can read shipments" on shipments;
create policy "Owner can read shipments" on shipments for select to authenticated using (true);
grant insert on public.shipments to anon;
grant select on public.shipments to authenticated;

drop policy if exists "Kiosk can insert tickets" on shipment_tickets;
create policy "Kiosk can insert tickets" on shipment_tickets for insert to anon with check (true);
drop policy if exists "Owner can read tickets" on shipment_tickets;
create policy "Owner can read tickets" on shipment_tickets for select to authenticated using (true);
grant insert on public.shipment_tickets to anon;
grant select on public.shipment_tickets to authenticated;

-- ---------------------------------------------------------------
-- Recent hauls with their newest ticket, readable from any device so a
-- driver can start a haul on one device and finish the ticket on another.
-- Runs as its owner, so the base tables stay insert-only for anon. Only
-- the last 4 days are exposed.
-- ---------------------------------------------------------------
create or replace view recent_shipments as
select
  s.client_id, s.departed_at, s.worker_id, s.trailer, s.bin_id, s.crop,
  s.bin_status, s.destination_id, s.est_bushels, s.est_weight_lb,
  t.ticket_number, t.gross_lb, t.tare_lb, t.net_lb, t.net_bushels,
  t.moisture_pct, t.test_weight, t.photo_path, t.notes,
  t.created_at as ticket_at,
  s.field_id, s.origin_type, s.origin_status,
  s.truck, s.destination_name, s.destination_location
from shipments s
left join lateral (
  select * from shipment_tickets st
  where st.shipment_client_id = s.client_id
  order by st.created_at desc
  limit 1
) t on true
where s.departed_at > now() - interval '4 days';

grant select on recent_shipments to anon, authenticated;

-- ---------------------------------------------------------------
-- Private bucket for scale ticket photos. The kiosk can upload but not
-- read or overwrite; only logged-in owner accounts can view.
-- ---------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('scale-tickets', 'scale-tickets', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

drop policy if exists "Kiosk can upload scale ticket photos" on storage.objects;
create policy "Kiosk can upload scale ticket photos" on storage.objects
  for insert to anon with check (bucket_id = 'scale-tickets');

drop policy if exists "Owner can view scale ticket photos" on storage.objects;
create policy "Owner can view scale ticket photos" on storage.objects
  for select to authenticated using (bucket_id = 'scale-tickets');

notify pgrst, 'reload schema';
