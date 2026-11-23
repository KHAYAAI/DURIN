import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { RequireMfa } from '../auth/mfa.decorator';
import { ApiKeysService } from './api-keys.service';
import { CreateApiKeyDto } from './dto/create-api-key.dto';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { CurrentOrg } from '../auth/current-org.decorator';
import { RequireScopes } from '../auth/scopes.decorator';
import { RequestContext } from '../common/request-context';
import { SCOPES } from '../common/scopes';

@Controller('api_keys')
@UseGuards(ApiKeyGuard)
export class ApiKeysController {
  constructor(private readonly apiKeys: ApiKeysService) {}

  @Post()
  @RequireScopes(SCOPES.API_KEYS_WRITE)
  @RequireMfa()
  create(@CurrentOrg() ctx: RequestContext, @Body() dto: CreateApiKeyDto) {
    return this.apiKeys.create(ctx.organisationId, dto.name, dto.scopes, ctx.scopes);
  }

  @Get()
  @RequireScopes(SCOPES.API_KEYS_READ)
  list(@CurrentOrg() ctx: RequestContext) {
    return this.apiKeys.list(ctx.organisationId);
  }

  @Delete(':id')
  @RequireScopes(SCOPES.API_KEYS_WRITE)
  @RequireMfa()
  revoke(@CurrentOrg() ctx: RequestContext, @Param('id') id: string) {
    return this.apiKeys.revoke(ctx.organisationId, id);
  }
}
