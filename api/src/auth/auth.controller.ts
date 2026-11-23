import { Body, Controller, ForbiddenException, Get, NotFoundException, Post, Put, UseGuards } from '@nestjs/common';
import { IsIn, IsOptional, IsString, IsUrl, Length, Matches } from 'class-validator';
import { ApiKeyGuard } from './api-key.guard';
import { CurrentOrg } from './current-org.decorator';
import { RequireScopes } from './scopes.decorator';
import { RequireMfa } from './mfa.decorator';
import { RequestContext } from '../common/request-context';
import { SCOPES } from '../common/scopes';
import { MfaService } from './mfa.service';
import { Inject } from '@nestjs/common';
import { WORKOS_PORT, WorkosPort } from './workos.port';
import { PrismaService } from '../prisma/prisma.service';

class ChallengeDto { @IsOptional() @IsString() @Length(1, 100) factorId?: string }
class VerifyDto {
  @IsString() @Length(36, 36) challengeId!: string;
  @IsString() @Matches(/^\d{6}$/, { message: 'code must be 6 digits' }) code!: string;
}
class PortalDto {
  @IsIn(['sso', 'dsync']) intent!: 'sso' | 'dsync';
  @IsOptional() @IsUrl({ require_tld: false, protocols: ['https', 'http'] }) returnUrl?: string;
}
class LinkOrgDto { @IsString() @Matches(/^org_[A-Za-z0-9]+$/) workosOrganizationId!: string }

@Controller('auth')
@UseGuards(ApiKeyGuard)
export class AuthController {
  constructor(
    private readonly mfa: MfaService,
    private readonly prisma: PrismaService,
    @Inject(WORKOS_PORT) private readonly workos: WorkosPort,
  ) {}

  private user(ctx: RequestContext) {
    if (ctx.authMethod !== 'workos' || !ctx.userId || !ctx.sessionId) {
      throw new ForbiddenException({ code: 'USER_SESSION_REQUIRED', message: 'This endpoint requires a signed-in dashboard user.' });
    }
    return { userId: ctx.userId, sessionId: ctx.sessionId };
  }

  @Get('me')
  @RequireScopes(SCOPES.ORGANISATIONS_READ)
  async me(@CurrentOrg() ctx: RequestContext) {
    const s = ctx.authMethod === 'workos' && ctx.userId && ctx.sessionId ? await this.mfa.status(ctx.organisationId, ctx.userId, ctx.sessionId) : null;
    return { organisationId: ctx.organisationId, authMethod: ctx.authMethod, userId: ctx.userId ?? null, scopes: ctx.scopes, mfa: s };
  }

  @Get('mfa/status')
  @RequireScopes(SCOPES.ORGANISATIONS_READ)
  status(@CurrentOrg() ctx: RequestContext) {
    const u = this.user(ctx);
    return this.mfa.status(ctx.organisationId, u.userId, u.sessionId);
  }

  @Post('mfa/enroll')
  @RequireScopes(SCOPES.ORGANISATIONS_READ)
  enroll(@CurrentOrg() ctx: RequestContext) {
    return this.mfa.enroll(this.user(ctx).userId);
  }

  @Post('mfa/challenge')
  @RequireScopes(SCOPES.ORGANISATIONS_READ)
  challenge(@CurrentOrg() ctx: RequestContext, @Body() dto: ChallengeDto) {
    const u = this.user(ctx);
    return this.mfa.challenge(ctx.organisationId, u.userId, u.sessionId, dto.factorId);
  }

  @Post('mfa/verify')
  @RequireScopes(SCOPES.ORGANISATIONS_READ)
  verify(@CurrentOrg() ctx: RequestContext, @Body() dto: VerifyDto) {
    const u = this.user(ctx);
    return this.mfa.verify(ctx.organisationId, u.userId, u.sessionId, dto.challengeId, dto.code);
  }

  /** Admin Portal link so the customer's IT admin can configure SAML/OIDC SSO for their organisation. */
  @Post('sso/portal-link')
  @RequireScopes(SCOPES.ADMIN)
  @RequireMfa()
  async portalLink(@CurrentOrg() ctx: RequestContext, @Body() dto: PortalDto) {
    const org = await this.prisma.organisation.findUniqueOrThrow({ where: { id: ctx.organisationId } });
    if (!org.workosOrganizationId) throw new NotFoundException('This organisation is not linked to a WorkOS organization');
    const link = await this.workos.portalLink(org.workosOrganizationId, dto.intent, dto.returnUrl);
    return { link, note: 'Single-use, short-lived link. Do not store or share.' };
  }

  /** Links a DURIN organisation to its WorkOS organization (API key with admin scope). */
  @Put('workos/organisation')
  @RequireScopes(SCOPES.ADMIN)
  @RequireMfa()
  async linkOrganisation(@CurrentOrg() ctx: RequestContext, @Body() dto: LinkOrgDto) {
    await this.prisma.organisation.update({ where: { id: ctx.organisationId }, data: { workosOrganizationId: dto.workosOrganizationId } });
    await this.prisma.auditLog.create({ data: { organisationId: ctx.organisationId, actorType: ctx.authMethod === 'workos' ? 'user' : 'api_key', actorId: ctx.apiKeyId, action: 'organisation.workos_linked', resourceType: 'organisation', resourceId: ctx.organisationId } });
    return { organisationId: ctx.organisationId, workosOrganizationId: dto.workosOrganizationId };
  }
}
