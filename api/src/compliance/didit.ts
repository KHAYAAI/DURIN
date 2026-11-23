import { createHmac, timingSafeEqual } from 'crypto';

/** Didit statuses (docs.didit.me/integration/verification-statuses) → DURIN's normalised status. */
export function mapDiditStatus(status: string): 'not_started' | 'pending' | 'approved' | 'rejected' | 'expired' {
  switch (status.trim().toLowerCase()) {
    case 'approved': return 'approved';
    case 'declined': return 'rejected';
    case 'expired':
    case 'kyc expired':
    case 'abandoned': return 'expired';
    case 'not started': return 'not_started';
    default: return 'pending'; // In Progress, In Review, Awaiting User, Resubmitted, …
  }
}

/** Canonical JSON used by X-Signature-V2: recursively sorted keys, compact, Unicode preserved. */
export function canonicalJson(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, norm((v as Record<string, unknown>)[k])]));
    }
    return v;
  };
  return JSON.stringify(norm(value));
}

export function signDiditV2(body: unknown, secret: string): string {
  return createHmac('sha256', secret).update(canonicalJson(body)).digest('hex');
}

/** Verifies X-Signature-V2 and rejects stale deliveries (> 300 s) to limit replay. */
export function verifyDiditSignature(opts: {
  body: unknown; signature?: string; timestamp?: string; secrets: string[]; now?: number; toleranceSeconds?: number;
}): boolean {
  const { body, signature, timestamp, secrets } = opts;
  if (!signature || !timestamp || secrets.length === 0) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > (opts.toleranceSeconds ?? 300)) return false;
  const given = Buffer.from(signature.trim().toLowerCase(), 'utf8');
  return secrets.some((secret) => {
    const expected = Buffer.from(signDiditV2(body, secret), 'utf8');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

export interface DiditSession { sessionId: string; url: string; status: string }

/** Minimal Didit client. Never logs the API key. `fetchImpl` is injectable for tests. */
export class DiditClient {
  constructor(
    private readonly cfg: { apiKey: string; baseUrl: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async createSession(p: { workflowId: string; vendorData: string; callback?: string; metadata?: Record<string, unknown> }): Promise<DiditSession> {
    const res = await this.fetchImpl(`${this.cfg.baseUrl.replace(/\/$/, '')}/v3/session/`, {
      method: 'POST',
      headers: { 'x-api-key': this.cfg.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ workflow_id: p.workflowId, vendor_data: p.vendorData, callback: p.callback, metadata: p.metadata }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Didit session creation failed (${res.status})`);
    const j = (await res.json()) as { session_id?: string; url?: string; status?: string };
    if (!j.session_id || !j.url) throw new Error('Didit returned an unexpected session response');
    return { sessionId: j.session_id, url: j.url, status: j.status ?? 'Not Started' };
  }
}

export function loadDiditConfig() {
  const apiKey = process.env.DIDIT_API_KEY;
  const secrets = [process.env.DIDIT_WEBHOOK_SECRET, process.env.DIDIT_WEBHOOK_SECRET_PREVIOUS].filter((s): s is string => !!s);
  return {
    enabled: (process.env.VERIFICATION_PROVIDER ?? 'sandbox') === 'didit',
    apiKey,
    baseUrl: process.env.DIDIT_BASE_URL || 'https://verification.didit.me',
    kycWorkflow: process.env.DIDIT_WORKFLOW_KYC,
    kybWorkflow: process.env.DIDIT_WORKFLOW_KYB,
    callback: process.env.DIDIT_CALLBACK_URL,
    secrets,
  };
}
