-- Atomic, idempotent persistence: run row + all decisions in one transaction.
create or replace function persist_run(p_run jsonb, p_decisions jsonb)
returns void
language plpgsql
as $$
begin
  insert into mfr_runs (id, formula, mfr, bud, passed, started_at, finished_at)
  values (
    (p_run->>'id')::uuid,
    p_run->'formula',
    p_run->'mfr',
    p_run->'bud',
    (p_run->>'passed')::boolean,
    (p_run->>'started_at')::timestamptz,
    (p_run->>'finished_at')::timestamptz
  )
  on conflict (id) do nothing;

  insert into agent_decisions (run_id, idx, agent, kind, payload, ts)
  select
    (p_run->>'id')::uuid,
    (d->>'idx')::int,
    d->>'agent',
    d->>'kind',
    d->'payload',
    (d->>'ts')::timestamptz
  from jsonb_array_elements(p_decisions) as d
  on conflict (run_id, idx) do nothing;
end;
$$;
