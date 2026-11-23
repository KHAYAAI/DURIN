import { Body, Controller, ForbiddenException, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ArrayMinSize, IsArray, IsInt, IsString, Length, Matches, Max, Min } from 'class-validator';
import { GatesService } from './gates.service';
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
@Controller('compliance/gates/g1')
@UseGuards(ApiKeyGuard)
export class GatesController {
  constructor(private readonly gates: GatesService) {}

  private human(ctx: RequestContext): string {
    if (ctx.authMethod !== 'workos') {
      throw new ForbiddenException({ code: 'USER_SESSION_REQUIRED', message: 'Gate G1 can only be recorded or revoked by a signed-in user.' });
    }
    return ctx.apiKeyId;
  }

  @Get()
  @RequireScopes(SCOPES.COMPLIANCE_READ)
  list(@CurrentOrg() ctx: RequestContext) {
    return this.gates.list(ctx.organisationId);
  }

  @Post()
  @RequireScopes(SCOPES.ADMIN)
  @RequireMfa()
  record(@CurrentOrg() ctx: RequestContext, @Body() dto: RecordG1Dto) {
    return this.gates.recordG1(ctx.organisationId, this.human(ctx), dto);
  }

  @Post(':id/revoke')
  @RequireScopes(SCOPES.ADMIN)
  @RequireMfa()
  revoke(@CurrentOrg() ctx: RequestContext, @Param('id') id: string) {
    return this.gates.revoke(ctx.organisationId, id, this.human(ctx));
  }
}
