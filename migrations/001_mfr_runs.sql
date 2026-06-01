create table if not exists mfr_runs (
  id          uuid primary key,            -- client-generated idempotency key
  formula     jsonb not null,
  mfr         jsonb,
  bud         jsonb,
  passed      boolean,
  started_at  timestamptz not null,
  finished_at timestamptz
);
