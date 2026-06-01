import type { SandboxRunner } from '@/lib/tools/calculator';

/** Returns a SandboxRunner, or null if Daytona is unavailable (caller falls back to in-process). */
export async function createCalcSandbox(): Promise<(SandboxRunner & { destroy: () => Promise<void> }) | null> {
  if (!process.env.DAYTONA_API_KEY) return null;
  try {
    // @ts-expect-error optional dependency not installed
    const { Daytona } = await import('@daytona/sdk');
    const daytona = new Daytona({
      apiKey: process.env.DAYTONA_API_KEY,
      apiUrl: process.env.DAYTONA_SERVER_URL,
    });
    const sandbox = await daytona.create({ language: 'typescript' });
    return {
      id: sandbox.id,
      run: async (code: string) => {
        const t0 = Date.now();
        const response = await sandbox.process.codeRun(code);
        return { result: response.result, exitCode: response.exitCode, ms: Date.now() - t0 };
      },
      destroy: async () => {
        try { await sandbox.delete(); } catch { /* best-effort */ }
      },
    };
  } catch (err) {
    console.error('[daytona] sandbox unavailable, falling back to in-process:', err);
    return null;
  }
}
