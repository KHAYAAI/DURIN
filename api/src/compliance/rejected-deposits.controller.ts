import { Body, Controller, ForbiddenException, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsIn, IsOptional, IsString, Length } from 'class-validator';
import { RejectedDepositsService } from './rejected-deposits.service';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { CurrentOrg } from '../auth/current-org.decorator';
import { RequireScopes } from '../auth/scopes.decorator';
import { RequireMfa } from '../auth/mfa.decorator';
import { RequestContext } from '../common/request-context';
import { SCOPES } from '../common/scopes';

class ReviewDto {
  @IsIn(['return', 'hold']) decision!: 'return' | 'hold';
  @IsOptional() @IsString() @Length(8, 200) returnAddress?: string;
  @IsOptional() @IsString() @Length(3, 500) overrideReason?: string;
  @IsOptional() @IsString() @Length(3, 200) screeningRef?: string;
  @IsOptional() @IsString() @Length(1, 500) note?: string;
}
class CompleteDto { @IsString() @Length(8, 200) returnTxHash!: string }

@Controller('compliance/rejected-deposits')
@UseGuards(ApiKeyGuard)
export class RejectedDepositsController {
  constructor(private readonly svc: RejectedDepositsService) {}

  private human(ctx: RequestContext): string {
    if (ctx.authMethod !== 'workos') throw new ForbiddenException({ code: 'USER_SESSION_REQUIRED', message: 'Only signed-in users can decide on returns.' });
    return ctx.apiKeyId;
  }

  @Get()
  @RequireScopes(SCOPES.COMPLIANCE_READ)
  list(@CurrentOrg() ctx: RequestContext, @Query('status') status?: string) { return this.svc.list(ctx.organisationId, status); }

  @Post(':id/review')
  @RequireScopes(SCOPES.COMPLIANCE_WRITE) @RequireMfa()
  review(@CurrentOrg() ctx: RequestContext, @Param('id') id: string, @Body() dto: ReviewDto) { return this.svc.review(ctx.organisationId, id, this.human(ctx), dto); }

  @Post(':id/approve')
  @RequireScopes(SCOPES.ADMIN) @RequireMfa()
  approve(@CurrentOrg() ctx: RequestContext, @Param('id') id: string) { return this.svc.approve(ctx.organisationId, id, this.human(ctx)); }

  @Post(':id/complete')
  @RequireScopes(SCOPES.COMPLIANCE_WRITE) @RequireMfa()
  complete(@CurrentOrg() ctx: RequestContext, @Param('id') id: string, @Body() dto: CompleteDto) { return this.svc.complete(ctx.organisationId, id, this.human(ctx), dto.returnTxHash); }
}
