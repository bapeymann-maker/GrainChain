-- GrainChain: widen the bins schema to match the real multi-site inventory,
-- then seed it. Run this in the Supabase SQL Editor.

-- The original schema only allowed organic/conventional and had no site,
-- crop, or capacity columns. The real inventory has genuine transitional
-- bins across several sites (not just the home-site wet bins the original
-- design covered), so this widens rather than mislabels real data.
alter table bins add column if not exists site text;
alter table bins add column if not exists crop text;
alter table bins add column if not exists capacity_k_bu numeric;
alter table bins add column if not exists bin_type text not null default 'storage';
alter table bins add column if not exists active boolean not null default true;
alter table bins alter column status drop not null; -- loadout bins carry no organic status

-- Widen the status check to include transitional, and allow null for
-- loadout bins. If this DROP fails because the constraint has a different
-- name in your project, look it up with: select conname from
-- pg_constraint where conrelid = 'bins'::regclass;
alter table bins drop constraint if exists bins_status_check;
alter table bins add constraint bins_status_check
  check (status in ('organic','transitional','conventional') or status is null);

insert into bins (id, site, name, capacity_k_bu, pct, status, crop, affidavit, bin_type, active) values
  ('HOME-H-1', 'HOME', 'H-1', 100.0, 0, 'organic', 'Corn', true, 'storage', true),
  ('HOME-H-2', 'HOME', 'H-2', 17.0, 0, 'organic', 'Corn', true, 'storage', true),
  ('HOME-H-3', 'HOME', 'H-3', 17.0, 0, 'organic', 'Corn', true, 'storage', true),
  ('HOME-H-4', 'HOME', 'H-4', 17.0, 0, 'organic', 'Corn', true, 'storage', true),
  ('HOME-H-5', 'HOME', 'H-5', 17.0, 100, 'transitional', 'Oats', false, 'storage', true),
  ('HOME-H-6', 'HOME', 'H-6', 33.0, 0, 'transitional', 'Corn', false, 'storage', true),
  ('HOME-H-7', 'HOME', 'H-7', 33.0, 70, 'transitional', 'Oats', false, 'storage', true),
  ('HOME-H-8', 'HOME', 'H-8', 52.0, 0, 'organic', 'Corn', true, 'storage', true),
  ('HOME-H-9', 'HOME', 'H-9', 52.0, 0, 'organic', 'Corn', true, 'storage', true),
  ('HOME-H-10', 'HOME', 'H-10', 30.0, 0, 'organic', 'Corn', true, 'storage', true),
  ('HOME-H-11', 'HOME', 'H-11', 175.0, 0, 'transitional', 'Corn', false, 'storage', true),
  ('HOME-A', 'HOME', 'A', 6.0, 0, 'organic', 'Corn', true, 'storage', true),
  ('HOME-B', 'HOME', 'B', 6.0, 0, 'organic', 'Corn', true, 'storage', true),
  ('MAU-M-41', 'MAU', 'M-41', 6.0, 0, 'conventional', 'Corn', false, 'storage', true),
  ('MAU-M-42', 'MAU', 'M-42', 15.0, 0, 'conventional', 'Corn', false, 'storage', true),
  ('MAU-M-43', 'MAU', 'M-43', 15.0, 0, 'conventional', 'Corn', false, 'storage', true),
  ('BENS-B-1', 'BEN''S', 'B-1', 19.0, 0, 'transitional', 'Soybeans', false, 'storage', true),
  ('FANCHER-F-31', 'FANCHER', 'F-31', 10.0, 0, 'transitional', 'Corn', false, 'storage', true),
  ('FANCHER-F-32', 'FANCHER', 'F-32', 10.0, 0, 'transitional', 'Corn', false, 'storage', true),
  ('FANCHER-F-33', 'FANCHER', 'F-33', 10.0, 0, 'transitional', 'Soybeans', false, 'storage', true),
  ('FANCHER-F-34', 'FANCHER', 'F-34', 10.0, 0, 'transitional', 'Soybeans', false, 'storage', true),
  ('FANCHER-F-35', 'FANCHER', 'F-35', 10.0, 0, 'transitional', 'Soybeans', false, 'storage', true),
  ('RYANS-R-20', 'RYAN''S', 'R-20', 19.0, 0, 'transitional', 'Corn', false, 'storage', true),
  ('RYANS-R-22', 'RYAN''S', 'R-22', 19.0, 0, 'transitional', 'Corn', false, 'storage', true),
  ('RYANS-R-23', 'RYAN''S', 'R-23', 19.0, 0, 'transitional', 'Corn', false, 'storage', true),
  ('RYANS-R-25', 'RYAN''S', 'R-25', 20.0, 0, 'transitional', 'Corn', false, 'storage', true),
  ('DANUBE-D-1', 'DANUBE', 'D-1', 75.0, 0, 'transitional', 'Beans', false, 'storage', true),
  ('DANUBE-D-2', 'DANUBE', 'D-2', 75.0, 0, 'transitional', 'Corn', false, 'storage', true),
  ('DANUBE-D-3', 'DANUBE', 'D-3', 75.0, 0, 'transitional', 'Corn', false, 'storage', true),
  ('DANUBE-C-1', 'DANUBE', 'C-1', 5.5, 0, 'organic', 'Corn', true, 'storage', true),
  ('DANUBE-C-2', 'DANUBE', 'C-2', 5.5, 0, 'organic', 'Corn', true, 'storage', true),
  ('DANUBE-C-3', 'DANUBE', 'C-3', 5.5, 0, 'organic', 'Corn', true, 'storage', true),
  ('DANUBE-C-4', 'DANUBE', 'C-4', 5.5, 0, 'organic', 'Corn', true, 'storage', true),
  ('DANUBE-C-5', 'DANUBE', 'C-5', 5.5, 0, 'organic', 'Corn', true, 'storage', true),
  ('DANUBE-O-6', 'DANUBE', 'O-6', 1.5, 0, null, null, false, 'loadout', true),
  ('DANUBE-O-7', 'DANUBE', 'O-7', 1.5, 0, null, null, false, 'loadout', true),
  ('HANSON-SILO-HS-W', 'HANSON SILO', 'HS-W', 78.0, 0, 'transitional', 'Corn', false, 'storage', true),
  ('HANSON-SILO-HS-M', 'HANSON SILO', 'HS-M', 78.0, 0, 'transitional', 'Corn', false, 'storage', true),
  ('HANSON-SILO-HS-E', 'HANSON SILO', 'HS-E', 78.0, 0, 'transitional', 'Corn', false, 'storage', true),
  ('FAIRFAX-FF-1', 'FAIRFAX', 'FF-1', 175.0, 0, 'organic', 'Corn', true, 'storage', true),
  ('FAIRFAX-FF-2', 'FAIRFAX', 'FF-2', 175.0, 0, 'organic', 'Corn', true, 'storage', true),
  ('FAIRFAX-FF-3', 'FAIRFAX', 'FF-3', 175.0, 0, 'organic', 'Corn', true, 'storage', true),
  ('FAIRFAX-FF-4', 'FAIRFAX', 'FF-4', 80.0, 0, null, null, false, 'storage', false),
  ('FAIRFAX-FF-O1', 'FAIRFAX', 'FF-O1', 17.0, 0, null, null, false, 'loadout', true),
  ('FAIRFAX-FF-O2', 'FAIRFAX', 'FF-O2', 17.0, 0, null, null, false, 'loadout', true);

-- Re-running later? Use this instead of a plain insert so it updates
-- existing rows by id rather than erroring on duplicates:
-- insert into bins (...) values (...)
-- on conflict (id) do update set
--   pct = excluded.pct, status = excluded.status, affidavit = excluded.affidavit,
--   crop = excluded.crop, active = excluded.active;
