import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ComplianceService } from './compliance.service';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { CurrentOrg } from '../auth/current-org.decorator';
import { RequireScopes } from '../auth/scopes.decorator';
import { RequestContext } from '../common/request-context';
import { SCOPES } from '../common/scopes';

@Controller('compliance')
@UseGuards(ApiKeyGuard)
export class ComplianceController {
  constructor(private readonly compliance: ComplianceService) {}

  @Post('verifications')
  @RequireScopes(SCOPES.COMPLIANCE_WRITE)
  startVerification(
    @CurrentOrg() ctx: RequestContext,
    @Body() body: { subjectType: string; subjectId: string; level?: string },
  ) {
    return this.compliance.startVerification(
      ctx.organisationId,
      body.subjectType,
      body.subjectId,
      body.level,
    );
  }

  @Post('verifications/:id/simulate_approve')
  @RequireScopes(SCOPES.COMPLIANCE_WRITE)
  simulateApprove(@CurrentOrg() ctx: RequestContext, @Param('id') id: string) {
    return this.compliance.simulateApproveVerification(ctx.organisationId, id);
  }

  @Get('verifications')
  @RequireScopes(SCOPES.COMPLIANCE_READ)
  listVerifications(@CurrentOrg() ctx: RequestContext) {
    return this.compliance.listVerifications(ctx.organisationId);
  }

  @Post('screenings')
  @RequireScopes(SCOPES.COMPLIANCE_WRITE)
  screen(
    @CurrentOrg() ctx: RequestContext,
    @Body() body: { subjectType: string; subjectId: string; screeningType: string },
  ) {
    return this.compliance.screen(
      ctx.organisationId,
      body.subjectType,
      body.subjectId,
      body.screeningType,
    );
  }

  @Post('limits')
  @RequireScopes(SCOPES.COMPLIANCE_WRITE)
  setLimit(
    @CurrentOrg() ctx: RequestContext,
    @Body()
    body: { name: string; assetCode?: string; dailyLimit?: string; perTxLimit?: string },
  ) {
    return this.compliance.setLimit(ctx.organisationId, body.name, body);
  }

  @Get('limits')
  @RequireScopes(SCOPES.COMPLIANCE_READ)
  listLimits(@CurrentOrg() ctx: RequestContext) {
    return this.compliance.listLimits(ctx.organisationId);
  }

  @Post('approvals')
  @RequireScopes(SCOPES.COMPLIANCE_WRITE)
  requestApproval(
    @CurrentOrg() ctx: RequestContext,
    @Body()
    body: { resourceType: string; resourceId: string; amount?: string; assetCode?: string },
  ) {
    return this.compliance.requestApproval(
      ctx.organisationId,
      body.resourceType,
      body.resourceId,
      body.amount,
      body.assetCode,
    );
  }

  @Post('approvals/:id/decide')
  @RequireScopes(SCOPES.COMPLIANCE_WRITE)
  decide(
    @CurrentOrg() ctx: RequestContext,
    @Param('id') id: string,
    @Body() body: { decision: 'approved' | 'rejected'; note?: string },
  ) {
    return this.compliance.decideApproval(ctx.organisationId, id, body.decision, body.note);
  }

  @Get('approvals')
  @RequireScopes(SCOPES.COMPLIANCE_READ)
  listApprovals(@CurrentOrg() ctx: RequestContext, @Query('status') status?: string) {
    return this.compliance.listApprovals(ctx.organisationId, status);
  }

  @Get('audit')
  @RequireScopes(SCOPES.COMPLIANCE_READ)
  audit(@CurrentOrg() ctx: RequestContext, @Query('limit') limit?: string) {
    return this.compliance.listAudit(
      ctx.organisationId,
      limit ? parseInt(limit, 10) : 50,
    );
  }
}
