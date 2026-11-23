import { Controller, Get } from '@nestjs/common';
import { DURIN_VERSION } from '@durin/shared';

@Controller()
export class HealthController {
  /**
   * Liveness / readiness probe.
   * Unversioned path for orchestrators; also available under /v1 if global prefix applies.
   * Note: global prefix is 'v1', so this becomes GET /v1/health unless we exclude it.
   */
  @Get('health')
  health() {
    return {
      status: 'ok',
      service: 'durin-api',
      version: DURIN_VERSION,
      milestone: 'M8',
      message: 'M0–M8 scaffold complete. Sandbox only — not production-ready.',
      timestamp: new Date().toISOString(),
      adapters: {
        layer1: process.env.LAYER1_ADAPTER || 'sandbox',
        layer2: process.env.LAYER2_ADAPTER || 'sandbox',
        liquidity: process.env.LIQUIDITY_ADAPTER || 'sandbox',
        compliance: process.env.COMPLIANCE_ADAPTER || 'sandbox',
      },
    };
  }
}
