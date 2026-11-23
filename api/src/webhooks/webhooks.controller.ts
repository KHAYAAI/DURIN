import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { WebhooksService } from './webhooks.service';
import { CreateWebhookDto } from './dto/create-webhook.dto';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { CurrentOrg } from '../auth/current-org.decorator';
import { RequireScopes } from '../auth/scopes.decorator';
import { RequestContext } from '../common/request-context';
import { SCOPES } from '../common/scopes';

@Controller('webhook_endpoints')
@UseGuards(ApiKeyGuard)
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Post()
  @RequireScopes(SCOPES.WEBHOOKS_WRITE)
  create(@CurrentOrg() ctx: RequestContext, @Body() dto: CreateWebhookDto) {
    return this.webhooks.create(ctx.organisationId, dto.url, dto.events);
  }

  @Get()
  @RequireScopes(SCOPES.WEBHOOKS_READ)
  list(@CurrentOrg() ctx: RequestContext) {
    return this.webhooks.list(ctx.organisationId);
  }

  @Post(':id/rotate_secret')
  @RequireScopes(SCOPES.WEBHOOKS_WRITE)
  rotate(@CurrentOrg() ctx: RequestContext, @Param('id') id: string) {
    return this.webhooks.rotateSecret(ctx.organisationId, id);
  }

  @Get(':id/deliveries')
  @RequireScopes(SCOPES.WEBHOOKS_READ)
  deliveries(@CurrentOrg() ctx: RequestContext, @Param('id') id: string, @Query('limit') limit?: string) {
    return this.webhooks.deliveries(ctx.organisationId, id, limit ? parseInt(limit, 10) || 50 : 50);
  }

  @Delete(':id')
  @RequireScopes(SCOPES.WEBHOOKS_WRITE)
  remove(@CurrentOrg() ctx: RequestContext, @Param('id') id: string) {
    return this.webhooks.remove(ctx.organisationId, id);
  }
}
