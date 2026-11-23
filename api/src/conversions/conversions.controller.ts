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
import { RequireMfa } from '../auth/mfa.decorator';
import { ConversionsService } from './conversions.service';
import { CreateQuoteDto } from './dto/create-quote.dto';
import { CreateConversionDto } from './dto/create-conversion.dto';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { CurrentOrg } from '../auth/current-org.decorator';
import { RequireScopes } from '../auth/scopes.decorator';
import { RequestContext } from '../common/request-context';
import { SCOPES } from '../common/scopes';

@Controller()
@UseGuards(ApiKeyGuard)
export class ConversionsController {
  constructor(private readonly conversions: ConversionsService) {}

  @Post('quotes')
  @RequireScopes(SCOPES.CONVERSIONS_WRITE)
  createQuote(@CurrentOrg() ctx: RequestContext, @Body() dto: CreateQuoteDto) {
    return this.conversions.createQuote(
      ctx.organisationId,
      dto.sourceAsset,
      dto.targetAsset,
      dto.sourceAmount,
    );
  }

  @Get('quotes/:id')
  @RequireScopes(SCOPES.CONVERSIONS_READ)
  getQuote(@CurrentOrg() ctx: RequestContext, @Param('id') id: string) {
    return this.conversions.getQuote(ctx.organisationId, id);
  }

  @Post('conversions')
  @RequireScopes(SCOPES.CONVERSIONS_WRITE)
  createConversion(
    @CurrentOrg() ctx: RequestContext,
    @Body() dto: CreateConversionDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.conversions.createConversion(
      ctx.organisationId,
      dto.quoteId,
      idempotencyKey,
    );
  }

  @Get('conversions')
  @RequireScopes(SCOPES.CONVERSIONS_READ)
  list(
    @CurrentOrg() ctx: RequestContext,
    @Query('limit') limit?: string,
  ) {
    return this.conversions.listConversions(
      ctx.organisationId,
      limit ? parseInt(limit, 10) : 50,
    );
  }

  /** Resolve a conversion whose liquidity-provider outcome is unknown. Never re-sends the order. */
  @Post('conversions/:id/resolve')
  @RequireScopes(SCOPES.CONVERSIONS_RESOLVE)
  @RequireMfa()
  resolve(
    @CurrentOrg() ctx: RequestContext,
    @Param('id') id: string,
    @Body() body: { confirmNotExecuted?: boolean },
  ) {
    return this.conversions.resolve(ctx.organisationId, id, body?.confirmNotExecuted === true ? 'not_executed' : undefined);
  }

  @Get('conversions/:id')
  @RequireScopes(SCOPES.CONVERSIONS_READ)
  get(@CurrentOrg() ctx: RequestContext, @Param('id') id: string) {
    return this.conversions.getConversion(ctx.organisationId, id);
  }
}
