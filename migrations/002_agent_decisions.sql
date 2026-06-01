create table if not exists agent_decisions (
  id       uuid primary key default gen_random_uuid(),
  run_id   uuid not null references mfr_runs(id),
  idx      integer not null,
  agent    text,
  kind     text not null,
  payload  jsonb not null,
  ts       timestamptz not null default now(),
  unique (run_id, idx)
);
