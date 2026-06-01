'use client';
import type { StreamEvent } from '@/lib/types';

export function WorkPanel({ events }: { events: StreamEvent[] }) {
  const rows = events.filter(
    (e) => e.type === 'tool_call' || e.type === 'tool_result' || e.type === 'agent_start' || e.type === 'sandbox_exec',
  );
  return (
    <div className="flex flex-col gap-1 font-mono text-xs">
      <h2 className="font-sans text-sm font-semibold uppercase tracking-wide text-gray-500">Live Agent Work</h2>
      {rows.map((e, i) => {
        if (e.type === 'agent_start') return <div key={i} className="mt-2 font-semibold text-blue-700">▸ {e.agent}</div>;
        if (e.type === 'tool_call') return <div key={i} className="text-gray-700">→ {e.tool}({JSON.stringify(e.input)})</div>;
        if (e.type === 'tool_result') return <div key={i} className="text-green-700">  ✓ {e.tool} ({e.ms}ms)</div>;
        if (e.type === 'sandbox_exec') return <div key={i} className="text-purple-700">  ⧉ sandbox {e.sandbox_id}</div>;
        return null;
      })}
    </div>
  );
}
