import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { CreatePaymentIntentDto } from './dto/create-payment-intent.dto';
import { CreatePaymentLinkDto } from './dto/create-payment-link.dto';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { CurrentOrg } from '../auth/current-org.decorator';
import { RequireScopes } from '../auth/scopes.decorator';
import { RequestContext } from '../common/request-context';
import { SCOPES } from '../common/scopes';

@Controller()
@UseGuards(ApiKeyGuard)
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post('payment_intents')
  @RequireScopes(SCOPES.PAYMENTS_WRITE)
  createIntent(
    @CurrentOrg() ctx: RequestContext,
    @Body() dto: CreatePaymentIntentDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.payments.createIntent(ctx.organisationId, dto, idempotencyKey);
  }

  @Get('payment_intents')
  @RequireScopes(SCOPES.PAYMENTS_READ)
  listIntents(@CurrentOrg() ctx: RequestContext, @Query('limit') limit?: string) {
    return this.payments.listIntents(
      ctx.organisationId,
      limit ? parseInt(limit, 10) : 50,
    );
  }

  @Get('payment_intents/:id')
  @RequireScopes(SCOPES.PAYMENTS_READ)
  getIntent(@CurrentOrg() ctx: RequestContext, @Param('id') id: string) {
    return this.payments.getIntent(ctx.organisationId, id);
  }

  /**
   * Sandbox-only: simulate customer payment and settle via ledger.
   * Label: simulated
   */
  @Post('payment_intents/:id/simulate_confirm')
  @RequireScopes(SCOPES.PAYMENTS_WRITE)
  simulateConfirm(@CurrentOrg() ctx: RequestContext, @Param('id') id: string) {
    return this.payments.simulateConfirm(ctx.organisationId, id);
  }

  @Post('payment_intents/:id/cancel')
  @RequireScopes(SCOPES.PAYMENTS_WRITE)
  cancel(@CurrentOrg() ctx: RequestContext, @Param('id') id: string) {
    return this.payments.cancelIntent(ctx.organisationId, id);
  }

  @Post('payment_links')
  @RequireScopes(SCOPES.PAYMENTS_WRITE)
  createLink(@CurrentOrg() ctx: RequestContext, @Body() dto: CreatePaymentLinkDto) {
    return this.payments.createLink(ctx.organisationId, dto);
  }

  @Get('payment_links')
  @RequireScopes(SCOPES.PAYMENTS_READ)
  listLinks(@CurrentOrg() ctx: RequestContext) {
    return this.payments.listLinks(ctx.organisationId);
  }

  @Get('payment_links/:id')
  @RequireScopes(SCOPES.PAYMENTS_READ)
  getLink(@CurrentOrg() ctx: RequestContext, @Param('id') id: string) {
    return this.payments.getLink(ctx.organisationId, id);
  }
}
