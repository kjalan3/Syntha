import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import stabilityData from '@/lib/data/stability.json';
import type { StabilityEntry } from '@/lib/types';

const CACHE_REG_PATH = join(process.cwd(), 'cache', 'regulatory.json');
const STALE_MS = 7 * 24 * 60 * 60 * 1000;

const BUNDLED_RATIONALE =
  'USP <795> (effective Nov 1, 2023) sets beyond-use dates by water-activity class and ' +
  'preservation: nonpreserved aqueous = 14 days refrigerated; preserved aqueous = 35 days; ' +
  'nonaqueous oral liquids = 90 days; other nonaqueous = 180 days. Stability data may only ' +
  'shorten these category defaults.';

export function lookupStability(ingredient: string): StabilityEntry | null {
  const target = ingredient.trim().toLowerCase();
  const list = stabilityData.ingredients as StabilityEntry[];
  return list.find((e) => e.ingredient.toLowerCase() === target) ?? null;
}

interface RegOpts { now?: number; cachePath?: string }

/** Fail-OPEN: rationale text only; deterministic BUD math never depends on this. */
export function getRegulatoryRules(opts: RegOpts = {}): { rationale_text: string; source: string } {
  const now = opts.now ?? Date.now();
  const path = opts.cachePath ?? CACHE_REG_PATH;
  try {
    if (existsSync(path)) {
      const cached = JSON.parse(readFileSync(path, 'utf-8'));
      const age = now - new Date(cached.fetched_at).getTime();
      if (age <= STALE_MS && typeof cached.rationale_text === 'string') {
        return { rationale_text: cached.rationale_text, source: cached.source ?? 'cache/regulatory.json' };
      }
    }
  } catch {
    /* fall through */
  }
  return { rationale_text: BUNDLED_RATIONALE, source: 'bundled USP <795> rationale (Nov 1, 2023)' };
}
