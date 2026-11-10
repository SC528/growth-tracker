-- Growth Tracker one-time transfer storage
create table if not exists public.growth_transfers (
  code_hash text primary key,
  payload jsonb not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table public.growth_transfers enable row level security;
-- No client-side access policies are intentionally defined. Only the Edge Function's
-- service-role key can read/write this table.
revoke all on public.growth_transfers from anon, authenticated;

create or replace function public.consume_growth_transfer(p_code_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  delete from public.growth_transfers
   where code_hash = p_code_hash
     and expires_at > now()
  returning payload into result;
  -- Also remove an expired matching code if it exists.
  delete from public.growth_transfers
   where code_hash = p_code_hash
     and expires_at <= now();
  return result;
end;
$$;

revoke all on function public.consume_growth_transfer(text) from public, anon, authenticated;
grant execute on function public.consume_growth_transfer(text) to service_role;

create index if not exists growth_transfers_expires_at_idx
  on public.growth_transfers (expires_at);

-- Optional scheduled cleanup: removes expired transfer payloads every minute.
-- Supabase projects support pg_cron; enable it if it is not already enabled.
create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule(
  'growth-transfer-expired-cleanup',
  '* * * * *',
  $$delete from public.growth_transfers where expires_at <= now();$$
);
