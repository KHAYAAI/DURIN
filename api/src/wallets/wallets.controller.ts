import { IsString, Matches } from 'class-validator';
import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { WalletsService } from './wallets.service';
import { CreateWalletDto } from './dto/create-wallet.dto';
import { CreateAddressDto } from './dto/create-address.dto';
import { CreateWithdrawalDto } from './dto/create-withdrawal.dto';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { CurrentOrg } from '../auth/current-org.decorator';
import { RequireScopes } from '../auth/scopes.decorator';
import { RequestContext } from '../common/request-context';
import { SCOPES } from '../common/scopes';

class SimulateDepositDto {
  /** Decimal string, e.g. "50.00" */
  @IsString()
  @Matches(/^\d+(\.\d+)?$/)
  amount!: string;
}

@Controller()
@UseGuards(ApiKeyGuard)
export class WalletsController {
  constructor(private readonly wallets: WalletsService) {}

  @Post('wallets')
  @RequireScopes(SCOPES.WALLETS_WRITE)
  create(@CurrentOrg() ctx: RequestContext, @Body() dto: CreateWalletDto) {
    return this.wallets.createWallet(ctx.organisationId, dto.label);
  }

  @Get('wallets')
  @RequireScopes(SCOPES.WALLETS_READ)
  list(@CurrentOrg() ctx: RequestContext) {
    return this.wallets.listWallets(ctx.organisationId);
  }

  @Get('wallets/:id')
  @RequireScopes(SCOPES.WALLETS_READ)
  get(@CurrentOrg() ctx: RequestContext, @Param('id') id: string) {
    return this.wallets.getWallet(ctx.organisationId, id);
  }

  @Post('wallets/:id/addresses')
  @RequireScopes(SCOPES.WALLETS_WRITE)
  createAddress(
    @CurrentOrg() ctx: RequestContext,
    @Param('id') id: string,
    @Body() dto: CreateAddressDto,
  ) {
    return this.wallets.createAddress(
      ctx.organisationId,
      id,
      dto.assetCode,
      dto.chain,
    );
  }

  @Post('deposit_addresses/:id/simulate_deposit')
  @RequireScopes(SCOPES.WALLETS_WRITE)
  simulateDeposit(
    @CurrentOrg() ctx: RequestContext,
    @Param('id') id: string,
    @Body() body: SimulateDepositDto,
  ) {
    return this.wallets.simulateDeposit(ctx.organisationId, id, body.amount);
  }

  @Post('withdrawals')
  @RequireScopes(SCOPES.WALLETS_WRITE)
  withdraw(
    @CurrentOrg() ctx: RequestContext,
    @Body() dto: CreateWithdrawalDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.wallets.requestWithdrawal(ctx.organisationId, dto, idempotencyKey);
  }

  @Get('withdrawals')
  @RequireScopes(SCOPES.WALLETS_READ)
  listWithdrawals(@CurrentOrg() ctx: RequestContext) {
    return this.wallets.listWithdrawals(ctx.organisationId);
  }

  @Get('withdrawals/:id')
  @RequireScopes(SCOPES.WALLETS_READ)
  getWithdrawal(@CurrentOrg() ctx: RequestContext, @Param('id') id: string) {
    return this.wallets.getWithdrawal(ctx.organisationId, id);
  }
}
