import { Module } from '@nestjs/common';
import { OrganisationsController } from './organisations.controller';
import { OrganisationsService } from './organisations.service';
import { ApiKeysModule } from '../api-keys/api-keys.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [ApiKeysModule, AuthModule],
  controllers: [OrganisationsController],
  providers: [OrganisationsService],
})
export class OrganisationsModule {}
