import { Body, Controller, ForbiddenException, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ArrayMinSize, IsArray, IsInt, IsString, Length, Matches, Max, Min } from 'class-validator';
import { GatesService } from './gates.service';
import { PrismaService } from '../prisma/prisma.service';
import { BadRequestException } from '@nestjs/common';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { CurrentOrg } from '../auth/current-org.decorator';
import { RequireScopes } from '../auth/scopes.decorator';
import { RequireMfa } from '../auth/mfa.decorator';
import { RequestContext } from '../common/request-context';
import { SCOPES } from '../common/scopes';

class RecordG1Dto {
  @IsString() @Length(3, 200) counselReference!: string;
  @IsString() @Matches(/^[0-9a-fA-F]{64}$/) documentSha256!: string;
  @IsArray() @ArrayMinSize(1) @IsString({ each: true }) assets!: string[];
  @IsArray() @ArrayMinSize(1) @IsString({ each: true }) jurisdictions!: string[];
  @IsInt() @Min(1) @Max(365) validDays!: number;
}

/** Gate G1 administration. Humans only: an API key can never record or revoke a sign-off. */
@Controller('compliance/gates')
@UseGuards(ApiKeyGuard)
export class GatesController {
  constructor(private readonly gates: GatesService, private readonly prisma: PrismaService) {}

  private human(ctx: RequestContext): string {
    if (ctx.authMethod !== 'workos') {
      throw new ForbiddenException({ code: 'USER_SESSION_REQUIRED', message: 'Gate G1 can only be recorded or revoked by a signed-in user.' });
    }
    return ctx.apiKeyId;
  }

  private gateOf(g: string): 'G1' | 'G2' | 'G3' {
    const up = g.toUpperCase();
    if (up !== 'G1' && up !== 'G2' && up !== 'G3') throw new BadRequestException('gate must be g1, g2 or g3');
    return up;
  }

  /** G2 and G3 are decisions about DURIN itself, so they can only be recorded on the house organisation. */
  private async requireScope(ctx: RequestContext, gate: 'G1' | 'G2' | 'G3') {
    if (gate === 'G1') return;
    const org = await this.prisma.organisation.findUniqueOrThrow({ where: { id: ctx.organisationId } });
    if (!org.isHouse) throw new ForbiddenException({ code: 'HOUSE_ORGANISATION_REQUIRED', message: `${gate} is recorded on the house organisation only.` });
  }

  @Get(':gate')
  @RequireScopes(SCOPES.COMPLIANCE_READ)
  list(@CurrentOrg() ctx: RequestContext, @Param('gate') gate: string) {
    return this.gates.list(ctx.organisationId, this.gateOf(gate));
  }

  @Post(':gate')
  @RequireScopes(SCOPES.ADMIN)
  @RequireMfa()
  async record(@CurrentOrg() ctx: RequestContext, @Param('gate') gate: string, @Body() dto: RecordG1Dto) {
    const g = this.gateOf(gate); const actor = this.human(ctx);
    await this.requireScope(ctx, g);
    return this.gates.record(g, ctx.organisationId, actor, dto);
  }

  @Post(':gate/:id/revoke')
  @RequireScopes(SCOPES.ADMIN)
  @RequireMfa()
  revoke(@CurrentOrg() ctx: RequestContext, @Param('id') id: string) {
    return this.gates.revoke(ctx.organisationId, id, this.human(ctx));
  }
}
