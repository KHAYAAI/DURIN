import { Body, Controller, Get, Headers, Post, UseGuards } from '@nestjs/common';
import { assertBootstrapAllowed } from '../common/bootstrap';
import { OrganisationsService } from './organisations.service';
import { CreateOrganisationDto } from './dto/create-organisation.dto';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { CurrentOrg } from '../auth/current-org.decorator';
import { RequireScopes } from '../auth/scopes.decorator';
import { RequestContext } from '../common/request-context';
import { SCOPES } from '../common/scopes';

@Controller('organisations')
export class OrganisationsController {
  constructor(private readonly organisations: OrganisationsService) {}

  /**
   * Public bootstrap endpoint — creates org + first API key.
   * In production this should be gated (invite-only, admin, or KYB flow).
   * Status: implemented (dev), awaiting regulatory / commercial controls for production.
   */
  @Post()
  create(@Body() dto: CreateOrganisationDto, @Headers('x-bootstrap-token') bootstrapToken?: string) {
    assertBootstrapAllowed(bootstrapToken);
    return this.organisations.create(dto.name, dto.ownerEmail, dto.ownerName, dto.adminKey);
  }

  @Get('me')
  @UseGuards(ApiKeyGuard)
  @RequireScopes(SCOPES.ORGANISATIONS_READ)
  me(@CurrentOrg() ctx: RequestContext) {
    return this.organisations.getMe(ctx.organisationId);
  }
}
