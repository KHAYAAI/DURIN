import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ReconciliationService } from './reconciliation.service';

/**
 * Periodic reconciliation for every active organisation. Off unless RECONCILIATION_INTERVAL_SECONDS
 * is set to a positive number (and never in tests). One run at a time per process.
 */
@Injectable()
export class ReconciliationWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger(ReconciliationWorker.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly prisma: PrismaService, private readonly recon: ReconciliationService) {}

  onApplicationBootstrap() {
    const seconds = Number(process.env.RECONCILIATION_INTERVAL_SECONDS ?? 0);
    if (!(seconds > 0) || process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.tick(), seconds * 1000);
    this.timer.unref();
    this.log.log(`Reconciliation worker every ${seconds}s`);
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const orgs = await this.prisma.organisation.findMany({ where: { status: 'active' }, select: { id: true } });
      for (const o of orgs) {
        try { await this.recon.run(o.id); } catch (e) { this.log.error(`Reconciliation failed for ${o.id}: ${e instanceof Error ? e.message : e}`); }
      }
    } finally {
      this.running = false;
    }
  }
}
