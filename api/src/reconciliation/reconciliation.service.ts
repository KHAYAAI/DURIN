import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { add, cmp, sub } from '@durin/ledger';
import { PrismaService } from '../prisma/prisma.service';
import { LAYER1_PORT } from '../providers/layer1/layer1.module';
import { Layer1Port } from '../providers/layer1/layer1.port';
import { LAYER2_PORT } from '../providers/layer2/layer2.module';
import { Layer2Port } from '../providers/layer2/layer2.port';
import { WebhookDeliveryService } from '../webhooks/webhook-delivery.service';
import { LedgerService } from '../ledger/ledger.service';

type Reported = Map<string, string>; // asset -> amount

/**
 * Reconciles DURIN's custody-reference ledger against what the custodians themselves report.
 *
 *  1. custody_mismatch: CUSTODY-REF ledger balance != custodian-reported balance (any delta)
 *  2. insolvent:        custody + liquidity-provider clearing < customer entitlements + in-transit
 *  3. provider_error:   the custodian could not be queried (never treated as a match)
 *
 * Breaks are persisted, raise a webhook, and must be acknowledged by an operator. The check never
 * "fixes" a balance: a break is evidence to investigate, not something to net away.
 */
@Injectable()
export class ReconciliationService {
  private readonly log = new Logger(ReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly webhooks: WebhookDeliveryService,
    @Inject(LAYER1_PORT) private readonly layer1: Layer1Port,
    @Inject(LAYER2_PORT) private readonly layer2: Layer2Port,
  ) {}

  async run(organisationId: string) {
    const accounts = await this.prisma.ledgerAccount.findMany({
      where: { organisationId, role: { not: null } },
      include: { balances: true },
    });
    const bal = (a: (typeof accounts)[number]) => a.balances[0]?.available.toFixed() ?? '0';
    const byRole = (role: string) => accounts.filter((a) => a.role === role);

    const source: 'simulated' | 'live' = this.layer1.mode === 'live' && this.layer2.mode === 'live' ? 'live' : 'simulated';
    const reported: Record<string, Reported | Error> = {};
    for (const [name, port] of [['layer1', this.layer1], ['layer2', this.layer2]] as const) {
      try {
        const rows = await port.getCustodyBalances(organisationId);
        reported[name] = new Map(rows.map((r) => [r.assetCode.toUpperCase(), r.available]));
      } catch (e) {
        reported[name] = e instanceof Error ? e : new Error('custody query failed');
      }
    }

    const breaks: Array<{ assetCode: string; custodian: string; kind: string; ledgerAmount: string; reportedAmount: string | null; delta: string | null; note?: string }> = [];
    const perAsset: Array<Record<string, string>> = [];

    for (const custody of byRole('custody_ref')) {
      const asset = custody.assetCode;
      const custodian = custody.custodian ?? 'layer1';
      const ledgerAmount = bal(custody);
      const r = reported[custodian];
      if (r instanceof Error) {
        breaks.push({ assetCode: asset, custodian, kind: 'provider_error', ledgerAmount, reportedAmount: null, delta: null, note: r.message.slice(0, 200) });
        continue;
      }
      const reportedAmount = r.get(asset) ?? '0';
      const delta = sub(ledgerAmount, reportedAmount);
      if (cmp(delta, '0') !== 0) {
        breaks.push({ assetCode: asset, custodian, kind: 'custody_mismatch', ledgerAmount, reportedAmount, delta });
      }

      const sum = (role: string) =>
        byRole(role).filter((a) => a.assetCode === asset).reduce((n, a) => add(n, bal(a)), '0');
      const customer = sum('customer');
      const inTransit = sum('in_transit');
      const lp = sum('lp_clearing');
      const backing = add(reportedAmount, lp);
      const owed = add(customer, inTransit);
      if (cmp(backing, owed) < 0) {
        breaks.push({ assetCode: asset, custodian, kind: 'insolvent', ledgerAmount: owed, reportedAmount: backing, delta: sub(backing, owed), note: 'custody + LP clearing < customer balances + in-transit' });
      }
      perAsset.push({ assetCode: asset, custodian, ledgerCustody: ledgerAmount, reportedCustody: reportedAmount, customer, inTransit, lpClearing: lp });
    }

    const integrity = await this.ledger.integrityReport(organisationId);
    const unresolved = await this.prisma.conversion.count({ where: { organisationId, status: 'processing', providerUnknown: true } });
    const status = breaks.length === 0 && integrity.healthy && unresolved === 0 ? 'clean' : 'breaks';

    const run = await this.prisma.reconciliationRun.create({
      data: {
        organisationId,
        status,
        source,
        summary: { assets: perAsset, ledgerIntegrityHealthy: integrity.healthy, unresolvedProviderOutcomes: unresolved } as Prisma.InputJsonValue,
        breaks: {
          create: breaks.map((b) => ({
            organisationId, assetCode: b.assetCode, custodian: b.custodian, kind: b.kind,
            ledgerAmount: new Prisma.Decimal(b.ledgerAmount),
            reportedAmount: b.reportedAmount === null ? null : new Prisma.Decimal(b.reportedAmount),
            delta: b.delta === null ? null : new Prisma.Decimal(b.delta),
            note: b.note,
          })),
        },
      },
      include: { breaks: true },
    });

    if (status === 'breaks') {
      this.log.error(`Reconciliation ${run.id} for ${organisationId}: ${breaks.length} break(s), ${unresolved} unresolved provider outcome(s)`);
      await this.webhooks.publish(organisationId, 'reconciliation.break_detected', this.serializeRun(run));
    }
    return this.serializeRun(run);
  }

  async latest(organisationId: string) {
    const run = await this.prisma.reconciliationRun.findFirst({ where: { organisationId }, orderBy: { checkedAt: 'desc' }, include: { breaks: true } });
    return run ? this.serializeRun(run) : null;
  }

  async listBreaks(organisationId: string, status?: string) {
    const rows = await this.prisma.reconciliationBreak.findMany({
      where: { organisationId, ...(status ? { status } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rows.map((b) => this.serializeBreak(b));
  }

  async acknowledge(organisationId: string, breakId: string, actor: string, note?: string) {
    if (!/^[0-9a-f-]{36}$/i.test(breakId)) throw new NotFoundException('Break not found');
    const res = await this.prisma.reconciliationBreak.updateMany({
      where: { id: breakId, organisationId, status: 'open' },
      data: { status: 'acknowledged', acknowledgedBy: actor, note: note?.slice(0, 500) },
    });
    if (res.count !== 1) throw new NotFoundException('Open break not found');
    await this.prisma.auditLog.create({
      data: { organisationId, actorType: 'api_key', actorId: actor, action: 'reconciliation.break_acknowledged', resourceType: 'reconciliation_break', resourceId: breakId },
    });
    return { id: breakId, status: 'acknowledged' };
  }

  private serializeRun(run: Prisma.ReconciliationRunGetPayload<{ include: { breaks: true } }>) {
    return {
      id: run.id,
      organisationId: run.organisationId,
      status: run.status,
      source: run.source,
      summary: run.summary,
      breaks: run.breaks.map((b) => this.serializeBreak(b)),
      checkedAt: run.checkedAt,
      note: run.source === 'simulated' ? 'Compared against SIMULATED custodian balances. Not evidence of real custody.' : undefined,
    };
  }

  private serializeBreak(b: Prisma.ReconciliationBreakGetPayload<object>) {
    return {
      id: b.id,
      assetCode: b.assetCode,
      custodian: b.custodian,
      kind: b.kind,
      ledgerAmount: b.ledgerAmount.toFixed(),
      reportedAmount: b.reportedAmount?.toFixed() ?? null,
      delta: b.delta?.toFixed() ?? null,
      status: b.status,
      note: b.note,
      createdAt: b.createdAt,
    };
  }
}
