import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { checkCompliance } from '@/lib/tools/compliance-gate';

const TMP = join(process.cwd(), 'cache');
const FDA = join(TMP, 'fda-list.json');
const FIXED_NOW = new Date('2026-05-31T12:00:00Z').getTime();

function writeCache(fetchedAt: string, ineligible: { name: string; reason: string }[]) {
  mkdirSync(TMP, { recursive: true });
  writeFileSync(FDA, JSON.stringify({ fetched_at: fetchedAt, ineligible }));
}

afterEach(() => { if (existsSync(FDA)) rmSync(FDA); });

describe('checkCompliance (fail-closed)', () => {
  it('fresh cache, drug not listed → eligible from fda_cache', () => {
    writeCache('2026-05-30T12:00:00Z', []);
    const r = checkCompliance('hydrocortisone', { now: FIXED_NOW });
    expect(r.eligible).toBe(true);
    expect(r.status).toBe('eligible');
    expect(r.source.origin).toBe('fda_cache');
    expect(r.source.stale).toBe(false);
  });

  it('fresh cache, drug listed → ineligible', () => {
    writeCache('2026-05-30T12:00:00Z', [{ name: 'estriol', reason: 'on list' }]);
    const r = checkCompliance('Estriol', { now: FIXED_NOW });
    expect(r.eligible).toBe(false);
    expect(r.status).toBe('ineligible');
  });

  it('NO cache, not in demo mode → unverifiable (fail closed)', () => {
    const r = checkCompliance('hydrocortisone', { now: FIXED_NOW, demoOffline: false });
    expect(r.eligible).toBe(false);
    expect(r.status).toBe('unverifiable');
    expect(r.source.origin).toBe('static_fallback');
  });

  it('NO cache but on static list → still ineligible (deny-list always blocks)', () => {
    const r = checkCompliance('bromocriptine', { now: FIXED_NOW, demoOffline: false });
    expect(r.status).toBe('ineligible');
  });

  it('NO cache but demo offline mode ON → eligible against fallback, marked non-authoritative', () => {
    const r = checkCompliance('hydrocortisone', { now: FIXED_NOW, demoOffline: true });
    expect(r.eligible).toBe(true);
    expect(r.status).toBe('eligible');
    expect(r.source.origin).toBe('static_fallback');
    expect(r.source.stale).toBe(true);
  });

  it('STALE cache (>7 days), not in demo mode → unverifiable', () => {
    writeCache('2026-05-01T12:00:00Z', []);
    const r = checkCompliance('hydrocortisone', { now: FIXED_NOW, demoOffline: false });
    expect(r.status).toBe('unverifiable');
  });
});
