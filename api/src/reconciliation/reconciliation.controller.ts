import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { RequireMfa } from '../auth/mfa.decorator';
import { ReconciliationService } from './reconciliation.service';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { CurrentOrg } from '../auth/current-org.decorator';
import { RequireScopes } from '../auth/scopes.decorator';
import { RequestContext } from '../common/request-context';
import { SCOPES } from '../common/scopes';

@Controller('reconciliation')
@UseGuards(ApiKeyGuard)
export class ReconciliationController {
  constructor(private readonly reconciliation: ReconciliationService) {}

  @Post('runs')
  @RequireScopes(SCOPES.RECONCILIATION_WRITE)
  run(@CurrentOrg() ctx: RequestContext) {
    return this.reconciliation.run(ctx.organisationId);
  }

  @Get('runs/latest')
  @RequireScopes(SCOPES.RECONCILIATION_READ)
  latest(@CurrentOrg() ctx: RequestContext) {
    return this.reconciliation.latest(ctx.organisationId);
  }

  @Get('breaks')
  @RequireScopes(SCOPES.RECONCILIATION_READ)
  breaks(@CurrentOrg() ctx: RequestContext, @Query('status') status?: string) {
    return this.reconciliation.listBreaks(ctx.organisationId, status);
  }

  @Post('breaks/:id/acknowledge')
  @RequireScopes(SCOPES.RECONCILIATION_WRITE)
  @RequireMfa()
  acknowledge(@CurrentOrg() ctx: RequestContext, @Param('id') id: string, @Body() body: { note?: string }) {
    return this.reconciliation.acknowledge(ctx.organisationId, id, ctx.apiKeyId ?? 'unknown', body?.note);
  }
}
