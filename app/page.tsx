'use client';
import { useState } from 'react';
import { FormulaInput } from '@/components/FormulaInput';
import { WorkPanel } from '@/components/WorkPanel';
import { MFRDocument } from '@/components/MFRDocument';
import { QASignoffPanel } from '@/components/QASignoffPanel';
import type { StreamEvent, Prescription, QAFinding, MFRSectionName, ComplianceSource } from '@/lib/types';

export default function Home() {
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [sections, setSections] = useState<Partial<Record<MFRSectionName, string>>>({});
  const [findings, setFindings] = useState<QAFinding[]>([]);
  const [signoff, setSignoff] = useState<{ passed: boolean; summary: string } | null>(null);
  const [compliance, setCompliance] = useState<{ status: string; source: ComplianceSource; reason?: string } | null>(null);
  const [audit, setAudit] = useState<{ state: string; detail?: string } | null>(null);
  const [running, setRunning] = useState(false);

  async function run(rx: Prescription) {
    setEvents([]); setSections({}); setFindings([]); setSignoff(null); setCompliance(null); setAudit(null);
    setRunning(true);
    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prescription: rx }),
      });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith('data:')) continue;
          const e = JSON.parse(line.slice(5).trim()) as StreamEvent;
          setEvents((prev) => [...prev, e]);
          if (e.type === 'mfr_section') setSections((p) => ({ ...p, [e.section]: e.content }));
          if (e.type === 'qa_finding') setFindings((p) => [...p, e]);
          if (e.type === 'qa_signoff') setSignoff({ passed: e.passed, summary: e.summary });
          if (e.type === 'compliance_result') setCompliance({ status: e.status, source: e.source, reason: e.reason });
          if (e.type === 'audit_status') setAudit({ state: e.state, detail: e.detail });
        }
      }
    } finally {
      setRunning(false);
    }
  }

  return (
    <main className="mx-auto grid max-w-6xl grid-cols-1 gap-6 p-6 md:grid-cols-2">
      <header className="md:col-span-2 border-b pb-3 text-lg font-bold">
        SYNTHA <span className="font-normal text-gray-500">| Formulation &amp; BUD Copilot</span>
      </header>
      <section className="rounded border p-4"><FormulaInput onRun={run} disabled={running} /></section>
      <section className="rounded border p-4"><WorkPanel events={events} /></section>
      <section className="rounded border p-4"><MFRDocument sections={sections} /></section>
      <section className="rounded border p-4">
        <QASignoffPanel findings={findings} signoff={signoff} compliance={compliance} audit={audit} />
      </section>
    </main>
  );
}
