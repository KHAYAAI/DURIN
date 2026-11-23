import { Controller, Get, Header } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import { DURIN_VERSION } from '@durin/shared';
import { isSandboxMode } from '../common/sandbox';

@Controller()
export class MetaController {
  @Get('openapi.yaml')
  @Header('Content-Type', 'application/yaml')
  openapiYaml() {
    const candidates = [
      join(__dirname, '..', '..', 'openapi', 'openapi.yaml'),
      join(process.cwd(), 'openapi', 'openapi.yaml'),
      join(process.cwd(), 'apps', 'api', 'openapi', 'openapi.yaml'),
    ];
    for (const p of candidates) {
      try {
        return readFileSync(p, 'utf8');
      } catch {
        /* try next */
      }
    }
    return 'openapi: 3.1.0\ninfo: { title: DURIN, version: 0.8.0 }\n# file not found at runtime — see apps/api/openapi/openapi.yaml\n';
  }

  /**
   * Honest capability statuses. Labels are the platform's status vocabulary; nothing here is
   * `production-ready`, and live money movement is not available.
   */
  @Get('version')
  version() {
    return {
      service: 'durin-api',
      version: DURIN_VERSION,
      api: 'v1',
      openapi: '/v1/openapi.yaml',
      mode: isSandboxMode() ? 'sandbox' : 'production',
      production_ready: false,
      capabilities: {
        ledger: { status: 'implemented', notes: 'Double-entry, DB-enforced invariants. Not yet security-reviewed.' },
        api_keys_and_auth: { status: 'implemented' },
        webhooks: { status: 'implemented', notes: 'Durable queue, signed, retried. Delivery is at-least-once.' },
        payments: { status: 'simulated', notes: 'No chain monitoring or banking rails.' },
        conversions: { status: 'simulated', live: 'awaiting regulatory approval' },
        wallets: { status: 'simulated', live: 'awaiting credentials' },
        compliance: {
          status: process.env.VERIFICATION_PROVIDER === 'didit' ? 'implemented' : 'simulated',
          live: 'awaiting commercial agreement and credentials (Didit workflows, webhook secret)',
        },
        reconciliation: { status: 'implemented', notes: 'Ledger custody vs custodian-reported balances. Sandbox compares against simulated balances.' },
        dashboard_auth: { status: 'implemented', notes: 'WorkOS AuthKit SSO + session-bound TOTP step-up. Needs WorkOS environment configuration.' },
      },
      gates: {
        G1_live_conversion: process.env.CONVERSION_LIVE_ENABLED === 'true' ? 'flag set (counsel sign-off asserted by operator)' : 'closed',
        live_adapters: 'none registered in this repository',
      },
    } as const;
  }
}
