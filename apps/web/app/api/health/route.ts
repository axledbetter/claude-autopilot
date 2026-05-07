// apps/web/app/api/health/route.ts
//
// Static 200 OK for platform health checks. Excluded from middleware matcher.
// Cache-Control: no-store so probes through CDN/intermediaries always hit
// the live process (codex plan-review WARNING: stale probe responses
// through caches mask actual outages).

export async function GET(): Promise<Response> {
  return new Response(JSON.stringify({ ok: true, service: 'claude-autopilot-web' }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  });
}
