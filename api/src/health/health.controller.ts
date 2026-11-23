import { Controller, Get, Res } from '@nestjs/common';
import { DURIN_VERSION } from '@durin/shared';
import { PrismaService } from '../prisma/prisma.service';
import { isSandboxMode } from '../common/sandbox';

@Controller()
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Readiness probe. Returns 200 only if the database answers; 503 otherwise so orchestrators
   * stop routing traffic. Unversioned path (excluded from the /v1 prefix).
   */
  @Get('health')
  async health(@Res({ passthrough: true }) res: { status(code: number): unknown }) {
    let database: 'up' | 'down' = 'up';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      database = 'down';
      res.status(503);
    }
    return {
      status: database === 'up' ? 'ok' : 'degraded',
      service: 'durin-api',
      version: DURIN_VERSION,
      mode: isSandboxMode() ? 'sandbox' : 'production',
      database,
      timestamp: new Date().toISOString(),
      adapters: {
        layer1: process.env.LAYER1_ADAPTER || 'sandbox',
        layer2: process.env.LAYER2_ADAPTER || 'sandbox',
      },
    };
  }
}
