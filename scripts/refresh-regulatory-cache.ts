import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { callRtrvr } from '@/lib/integrations/rtrvr';

async function main() {
  const cacheDir = join(process.cwd(), 'cache');
  mkdirSync(cacheDir, { recursive: true });
  const now = new Date().toISOString();

  const reg = await callRtrvr('Summarize USP <795> (Nov 1, 2023) BUD rules by water-activity class and preservation.', [
    'https://www.usp.org/',
  ]);
  writeFileSync(
    join(cacheDir, 'regulatory.json'),
    JSON.stringify({ fetched_at: now, source: 'rtrvr.ai / USP <795> (Nov 1, 2023)', rationale_text: String(reg) }, null, 2),
  );

  const fda = (await callRtrvr('List FDA 503A difficult-to-compound bulk drugs and drugs withdrawn for safety.', [
    'https://www.fda.gov/',
  ])) as { ineligible?: { name: string; reason: string }[] };
  writeFileSync(
    join(cacheDir, 'fda-list.json'),
    JSON.stringify({ fetched_at: now, source: 'rtrvr.ai / FDA 503A Bulks List', ineligible: fda.ineligible ?? [] }, null, 2),
  );

  console.log('Wrote cache/regulatory.json and cache/fda-list.json at', now);
}

main().catch((err) => {
  console.error('[refresh-regulatory-cache] failed:', err);
  process.exit(1);
});
