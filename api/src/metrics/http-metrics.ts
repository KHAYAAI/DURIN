/** In-process HTTP metrics (Prometheus text format). Per-process: aggregate across instances in Prometheus. */
const BUCKETS = [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

interface Series { count: number; sum: number; buckets: number[] }
const requests = new Map<string, number>();
const durations = new Map<string, Series>();

export function recordRequest(method: string, route: string, status: number, seconds: number): void {
  const k = `${method}|${route}|${Math.floor(status / 100)}xx`;
  requests.set(k, (requests.get(k) ?? 0) + 1);
  const dk = `${method}|${route}`;
  const s = durations.get(dk) ?? { count: 0, sum: 0, buckets: BUCKETS.map(() => 0) };
  s.count++; s.sum += seconds;
  BUCKETS.forEach((b, i) => { if (seconds <= b) s.buckets[i]!++; });
  durations.set(dk, s);
}

const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

export function renderHttpMetrics(): string {
  const out: string[] = ['# HELP durin_http_requests_total HTTP requests by method, route template and status class', '# TYPE durin_http_requests_total counter'];
  for (const [k, v] of requests) {
    const [m, r, c] = k.split('|');
    out.push(`durin_http_requests_total{method="${esc(m!)}",route="${esc(r!)}",status="${c}"} ${v}`);
  }
  out.push('# HELP durin_http_request_duration_seconds Request latency', '# TYPE durin_http_request_duration_seconds histogram');
  for (const [k, s] of durations) {
    const [m, r] = k.split('|');
    const l = `method="${esc(m!)}",route="${esc(r!)}"`;
    BUCKETS.forEach((b, i) => out.push(`durin_http_request_duration_seconds_bucket{${l},le="${b}"} ${s.buckets[i]}`));
    out.push(`durin_http_request_duration_seconds_bucket{${l},le="+Inf"} ${s.count}`, `durin_http_request_duration_seconds_sum{${l}} ${s.sum}`, `durin_http_request_duration_seconds_count{${l}} ${s.count}`);
  }
  return out.join('\n');
}

export function resetHttpMetrics(): void { requests.clear(); durations.clear(); }
