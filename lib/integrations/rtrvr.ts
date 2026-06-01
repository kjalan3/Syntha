export async function callRtrvr(input: string, urls: string[]): Promise<unknown> {
  const res = await fetch('https://api.rtrvr.ai/agent', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RTRVR_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ input, urls, response: { verbosity: 'final' } }),
  });
  if (!res.ok) throw new Error(`Rtrvr error ${res.status}`);
  const data = await res.json();
  return data.result?.json ?? data.result;
}
