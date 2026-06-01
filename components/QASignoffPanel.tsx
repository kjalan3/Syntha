'use client';
import type { QAFinding, ComplianceSource } from '@/lib/types';

export function QASignoffPanel({
  findings, signoff, compliance, audit,
}: {
  findings: QAFinding[];
  signoff: { passed: boolean; summary: string } | null;
  compliance: { status: string; source: ComplianceSource; reason?: string } | null;
  audit: { state: string; detail?: string } | null;
}) {
  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">QA Sign-Off</h2>

      {compliance && (
        <div className="rounded border p-2 text-xs">
          <div className="font-semibold">Compliance: {compliance.status}</div>
          <div className="text-gray-500">
            source: {compliance.source.origin} · {compliance.source.fetched_at ?? 'unknown date'} ·
            {compliance.source.stale ? ' STALE' : ' fresh'}
          </div>
          {compliance.reason && <div className="text-red-700">{compliance.reason}</div>}
        </div>
      )}

      {findings.map((f, i) => (
        <div key={i} className={f.severity === 'error' ? 'text-red-700 text-sm' : 'text-green-700 text-sm'}>
          {f.severity === 'error' ? '✗' : '✓'} {f.message}
        </div>
      ))}

      {signoff && (
        <div className={`rounded p-2 text-sm font-bold ${signoff.passed ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
          {signoff.passed ? '● PASSED' : '● FAILED — Hold'}: {signoff.summary}
        </div>
      )}

      {audit && (
        <div className={`text-xs ${audit.state === 'written' ? 'text-gray-500' : 'text-amber-700'}`}>
          Audit: {audit.state}{audit.detail ? ` — ${audit.detail}` : ''}
        </div>
      )}
    </div>
  );
}
