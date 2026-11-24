import { Body, Controller, ForbiddenException, Get, Headers, NotFoundException, Post, UseGuards } from '@nestjs/common';
import { IsString, Length, Matches } from 'class-validator';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { CurrentOrg } from '../auth/current-org.decorator';
import { RequireScopes } from '../auth/scopes.decorator';
import { RequestContext } from '../common/request-context';
import { SCOPES } from '../common/scopes';
import { assertBootstrapAllowed } from '../common/bootstrap';
import { PrismaService } from '../prisma/prisma.service';
import { HouseService } from './house.service';
import { sandboxCustody } from '../providers/sandbox-custody';
import { isSandboxMode } from '../common/sandbox';

class CapitalDto {
  @IsString() @Matches(/^[A-Z]{3,5}$/) assetCode!: string;
  @IsString() @Matches(/^\d+(\.\d{1,18})?$/) amount!: string;
  @IsString() @Length(3, 100) @Matches(/^[A-Za-z0-9._:-]+$/) evidenceRef!: string;
}

/** House organisation endpoints. Callable only by the house organisation's own admin key. */
@Controller('house')
@UseGuards(ApiKeyGuard)
export class HouseController {
  constructor(private readonly prisma: PrismaService, private readonly house: HouseService) {}

  private async requireHouse(ctx: RequestContext) {
    const org = await this.prisma.organisation.findUniqueOrThrow({ where: { id: ctx.organisationId } });
    if (!org.isHouse) throw new ForbiddenException({ code: 'HOUSE_ORGANISATION_REQUIRED', message: 'Only the house organisation can use this endpoint.' });
    return org.id;
  }

  @Get('position')
  @RequireScopes(SCOPES.LEDGER_READ)
  async position(@CurrentOrg() ctx: RequestContext) { return this.house.position(await this.requireHouse(ctx)); }

  @Get('netting-batches')
  @RequireScopes(SCOPES.LEDGER_READ)
  async batches(@CurrentOrg() ctx: RequestContext) {
    await this.requireHouse(ctx);
    const rows = await this.prisma.nettingBatch.findMany({ orderBy: { createdAt: 'desc' }, take: 50 });
    return rows.map((b) => ({ id: b.id, status: b.status, baseAsset: b.baseAsset, hedgeAction: b.hedgeAction, hedgeBaseAmount: b.hedgeBaseAmount, failureReason: b.failureReason, createdAt: b.createdAt }));
  }

  /** Operator action: records capital the house has ALREADY placed with the custodian (bootstrap token + admin key). */
  @Post('capital')
  @RequireScopes(SCOPES.ADMIN)
  async capital(@CurrentOrg() ctx: RequestContext, @Body() dto: CapitalDto, @Headers('x-bootstrap-token') token?: string) {
    const org = await this.requireHouse(ctx);
    assertBootstrapAllowed(token);
    const r = await this.house.recordCapital(org, dto.assetCode, dto.amount, dto.evidenceRef);
    if (isSandboxMode()) sandboxCustody.creditOnce(`house-capital-${dto.evidenceRef}`, org, dto.assetCode, dto.amount);
    return { ...r, note: isSandboxMode() ? 'Sandbox: simulated custody credited.' : 'Recorded. Reconciliation will flag a break if the custodian does not show these funds.' };
  }
}
void NotFoundException;
