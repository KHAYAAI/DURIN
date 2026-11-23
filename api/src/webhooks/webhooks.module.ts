import { Module } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { WebhookDeliveryService } from './webhook-delivery.service';
import { WebhookWorker } from './webhook.worker';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [WebhooksController],
  providers: [WebhooksService, WebhookDeliveryService, WebhookWorker],
  exports: [WebhooksService, WebhookDeliveryService, WebhookWorker],
})
export class WebhooksModule {}
