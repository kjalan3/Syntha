import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import fallback from '@/lib/data/fda-compliance-fallback.json';
import type { ComplianceResult, FDAListResult, ComplianceSource } from '@/lib/types';

const CACHE_FDA_PATH = join(process.cwd(), 'cache', 'fda-list.json');
const STALE_MS = 7 * 24 * 60 * 60 * 1000;

interface Options {
  now?: number;
  demoOffline?: boolean;
  cachePath?: string;
}

export function getFDAList(opts: Options = {}): FDAListResult {
  const now = opts.now ?? Date.now();
  const path = opts.cachePath ?? CACHE_FDA_PATH;
  try {
    if (existsSync(path)) {
      const cached = JSON.parse(readFileSync(path, 'utf-8'));
      const age = now - new Date(cached.fetched_at).getTime();
      const stale = age > STALE_MS;
      return {
        ineligible: cached.ineligible ?? [],
        origin: 'fda_cache',
        fetched_at: cached.fetched_at,
        stale,
        authoritative: !stale,
      };
    }
  } catch {
    /* fall through to static fallback */
  }
  return {
    ineligible: fallback.ineligible ?? [],
    origin: 'static_fallback',
    fetched_at: fallback.updated ?? null,
    stale: true,
    authoritative: false,
  };
}

function provenance(list: FDAListResult): ComplianceSource {
  return { origin: list.origin, fetched_at: list.fetched_at, stale: list.stale };
}

function matches(listName: string, drug: string): boolean {
  return listName.trim().toLowerCase() === drug.trim().toLowerCase();
}

export function checkCompliance(drug: string, opts: Options = {}): ComplianceResult {
  const demoOffline = opts.demoOffline ?? process.env.DEMO_OFFLINE_MODE === 'true';
  const list = getFDAList(opts);
  const hit = list.ineligible.find((e) => matches(e.name, drug));

  if (hit) {
    return { eligible: false, status: 'ineligible', drug, reason: hit.reason, source: provenance(list) };
  }

  if (!list.authoritative && !demoOffline) {
    return {
      eligible: false,
      status: 'unverifiable',
      drug,
      reason:
        'FDA difficult-to-compound list could not be confirmed current; refusing to certify eligibility. Run scripts/refresh-regulatory-cache.ts.',
      source: provenance(list),
    };
  }

  return { eligible: true, status: 'eligible', drug, source: provenance(list) };
}
