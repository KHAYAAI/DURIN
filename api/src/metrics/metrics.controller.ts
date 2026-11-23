import { Controller, Get, Header, Headers, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { renderHttpMetrics } from './http-metrics';
import { watcherStatus } from '../chains/deposit-watcher.service';

type Row = Record<string, bigint | number | Date | null>;
const n = (v: unknown) => Number(v ?? 0);

/**
 * Prometheus scrape endpoint at /metrics (unversioned). Requires `Authorization: Bearer $METRICS_TOKEN`;
 * in production an unset token disables the endpoint. Business gauges are computed per scrape from
 * the database and carry NO tenant identifiers or amounts.
 */
@Controller()
export class MetricsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4')
  async metrics(@Headers('authorization') auth?: string) {
    const token = process.env.METRICS_TOKEN;
    if (!token) {
      if (process.env.NODE_ENV === 'production') throw new UnauthorizedException('Metrics are disabled: set METRICS_TOKEN');
    } else {
      const given = Buffer.from((auth ?? '').replace(/^Bearer /, ''));
      const want = Buffer.from(token);
      if (given.length !== want.length || !timingSafeEqual(given, want)) throw new UnauthorizedException('Invalid metrics token');
    }

    const [r] = await this.prisma.$queryRaw<Row[]>`
      SELECT
        (SELECT count(*) FROM conversions WHERE status = 'processing' AND provider_unknown) AS unknown_conversions,
        (SELECT count(*) FROM conversions WHERE status = 'processing' AND NOT provider_unknown AND created_at < now() - interval '5 minutes') AS stuck_conversions,
        (SELECT count(*) FROM provider_calls WHERE status IN ('sent','unknown') AND created_at < now() - interval '2 minutes') AS stale_provider_calls,
        (SELECT count(*) FROM reconciliation_breaks WHERE status = 'open') AS open_breaks,
        (SELECT COALESCE(EXTRACT(EPOCH FROM now() - max(checked_at)), -1) FROM reconciliation_runs) AS seconds_since_recon,
        (SELECT count(*) FROM webhook_deliveries WHERE status = 'pending' AND next_attempt_at < now() - interval '5 minutes') AS webhook_backlog,
        (SELECT count(*) FROM webhook_deliveries WHERE status = 'failed') AS webhook_failed,
        (SELECT count(*) FROM withdrawal_requests WHERE status IN ('requested','processing') AND created_at < now() - interval '10 minutes') AS stuck_withdrawals,
        (SELECT count(*) FROM verification_records WHERE status = 'pending' AND created_at < now() - interval '7 days') AS stale_verifications`;
    const g = (name: string, help: string, v: unknown) => `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name} ${n(v)}`;
    return [
      renderHttpMetrics(),
      g('durin_conversions_provider_unknown', 'Conversions whose liquidity-provider outcome is unknown (funds reserved)', r?.unknown_conversions),
      g('durin_conversions_stuck', 'Conversions processing > 5m with no unknown outcome', r?.stuck_conversions),
      g('durin_provider_calls_stale', 'Provider calls sent/unknown for > 2m', r?.stale_provider_calls),
      g('durin_reconciliation_open_breaks', 'Open reconciliation breaks', r?.open_breaks),
      g('durin_reconciliation_age_seconds', 'Seconds since the last reconciliation run (-1 = never)', r?.seconds_since_recon),
      g('durin_webhook_backlog', 'Webhook deliveries overdue by > 5m', r?.webhook_backlog),
      g('durin_webhook_failed', 'Webhook deliveries that exhausted retries', r?.webhook_failed),
      g('durin_withdrawals_stuck', 'Withdrawals requested/processing for > 10m', r?.stuck_withdrawals),
      g('durin_deposit_watcher_age_seconds', 'Seconds since the Solana deposit watcher last completed an error-free pass (-1 = never)', watcherStatus.lastSuccessAt ? Math.floor((Date.now() - watcherStatus.lastSuccessAt) / 1000) : -1),
      g('durin_verifications_stale', 'KYC/KYB verifications pending > 7d', r?.stale_verifications),
      '',
    ].join('\n');
  }
}
