-- GrainChain: real worker roster, replacing the 3 hardcoded demo PINs.
-- Run in the Supabase SQL Editor.

create table if not exists workers (
  id text primary key,
  name text not null,
  pin text not null,
  active boolean not null default true
);

alter table workers enable row level security;
create policy "Kiosk can read workers" on workers for select to anon using (true);
grant select on public.workers to anon;

-- Once you send me the real names/PINs, I'll generate the insert
-- statements the same way I did for fields and bins.
