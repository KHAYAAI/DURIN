import { Body, Controller, HttpCode, Headers, Post, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ComplianceService } from './compliance.service';
import { loadDiditConfig, verifyDiditSignature } from './didit';

/**
 * Didit webhook receiver. Not API-key authenticated: authenticity comes solely from the
 * X-Signature-V2 HMAC (secret from DIDIT_WEBHOOK_SECRET) and a 300 s timestamp window.
 * The tenant is derived from the verification record, never from the payload.
 */
@Controller('webhooks/didit')
export class DiditWebhookController {
  constructor(private readonly compliance: ComplianceService) {}

  @Post()
  @HttpCode(200)
  async receive(
    @Body() body: Record<string, unknown>,
    @Headers('x-signature-v2') signature?: string,
    @Headers('x-timestamp') timestamp?: string,
  ) {
    const cfg = loadDiditConfig();
    if (cfg.secrets.length === 0) {
      throw new ServiceUnavailableException({ code: 'PROVIDER_NOT_CONFIGURED', message: 'Didit webhook secret is not configured.' });
    }
    if (!verifyDiditSignature({ body, signature, timestamp, secrets: cfg.secrets })) {
      throw new UnauthorizedException('Invalid webhook signature');
    }
    const result = await this.compliance.applyDiditEvent(body);
    return { received: true, result };
  }
}
