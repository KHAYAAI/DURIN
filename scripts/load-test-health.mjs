#!/usr/bin/env node
/**
 * Simple concurrency smoke test against /health and optional authenticated route.
 * Usage: node scripts/load-test-health.mjs [baseUrl] [concurrency] [total]
 */
const base = process.argv[2] || 'http://localhost:3000';
const concurrency = Number(process.argv[3] || 20);
const total = Number(process.argv[4] || 200);

async function one() {
  const t0 = Date.now();
  const res = await fetch(`${base}/health`);
  return { status: res.status, ms: Date.now() - t0 };
}

async function main() {
  console.log(`Load test ${base}/health concurrency=${concurrency} total=${total}`);
  const results = [];
  let i = 0;
  async function worker() {
    while (i < total) {
      const n = i++;
      try {
        results[n] = await one();
      } catch (e) {
        results[n] = { status: 0, ms: 0, error: String(e) };
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const ok = results.filter((r) => r && r.status === 200).length;
  const times = results.filter((r) => r && r.ms).map((r) => r.ms).sort((a, b) => a - b);
  const p50 = times[Math.floor(times.length * 0.5)] || 0;
  const p95 = times[Math.floor(times.length * 0.95)] || 0;
  console.log(JSON.stringify({ ok, failed: total - ok, p50_ms: p50, p95_ms: p95 }, null, 2));
  process.exit(ok === total ? 0 : 1);
}

main();
