-- Shared, atomic rate limiter backed by Postgres, so limits hold across all
-- serverless instances (the in-process Map limiter did not). Fixed-window.

create table if not exists rate_limits (
  bucket    text primary key,        -- e.g. "upload:203.0.113.7"
  count     int  not null default 0,
  reset_at  timestamptz not null
);

alter table rate_limits enable row level security;  -- server (service role) only

-- Atomically record a hit and report whether the caller is still under the
-- limit for the current window. Returns the new count and the window reset.
create or replace function public.rate_limit_hit(
  p_bucket text, p_limit int, p_window_seconds int
) returns table(allowed boolean, remaining int, reset_at timestamptz)
language plpgsql as $$
declare
  v_now   timestamptz := now();
  v_count int;
  v_reset timestamptz;
begin
  insert into rate_limits as r (bucket, count, reset_at)
    values (p_bucket, 1, v_now + make_interval(secs => p_window_seconds))
  on conflict (bucket) do update
    set count = case when r.reset_at < v_now then 1 else r.count + 1 end,
        reset_at = case when r.reset_at < v_now
                        then v_now + make_interval(secs => p_window_seconds)
                        else r.reset_at end
  returning r.count, r.reset_at into v_count, v_reset;

  return query select (v_count <= p_limit), greatest(0, p_limit - v_count), v_reset;
end;
$$;
