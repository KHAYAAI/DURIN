import { Body, Controller, Get, Headers, Param, Post, Query, UseGuards } from '@nestjs/common';
import { LedgerService } from './ledger.service';
import { CreateAccountDto } from './dto/create-account.dto';
import { PostJournalDto } from './dto/post-journal.dto';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { CurrentOrg } from '../auth/current-org.decorator';
import { RequireScopes } from '../auth/scopes.decorator';
import { RequestContext } from '../common/request-context';
import { SCOPES } from '../common/scopes';
import { assertSandboxOnly } from '../common/sandbox';

@Controller()
@UseGuards(ApiKeyGuard)
export class LedgerController {
  constructor(private readonly ledger: LedgerService) {}

  @Post('accounts')
  @RequireScopes(SCOPES.ADMIN)
  createAccount(@CurrentOrg() ctx: RequestContext, @Body() dto: CreateAccountDto) {
    return this.ledger.createAccount(ctx.organisationId, dto);
  }

  @Get('accounts')
  @RequireScopes(SCOPES.ORGANISATIONS_READ)
  listAccounts(@CurrentOrg() ctx: RequestContext) {
    return this.ledger.listAccounts(ctx.organisationId);
  }

  @Get('accounts/:id')
  @RequireScopes(SCOPES.ORGANISATIONS_READ)
  getAccount(@CurrentOrg() ctx: RequestContext, @Param('id') id: string) {
    return this.ledger.getAccount(ctx.organisationId, id);
  }

  @Get('accounts/:id/balances')
  @RequireScopes(SCOPES.ORGANISATIONS_READ)
  getBalances(@CurrentOrg() ctx: RequestContext, @Param('id') id: string) {
    return this.ledger.getBalances(ctx.organisationId, id);
  }

  @Post('journals')
  @RequireScopes(SCOPES.ADMIN)
  postJournal(
    @CurrentOrg() ctx: RequestContext,
    @Body() dto: PostJournalDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    // Clients must never write to the ledger directly: that would mint balances with no backing.
    // Real money movement happens only through payments, conversions and withdrawals.
    assertSandboxOnly('Manual journal posting');
    return this.ledger.postJournal(ctx.organisationId, dto, idempotencyKey);
  }

  @Get('journals')
  @RequireScopes(SCOPES.ORGANISATIONS_READ)
  listJournals(@CurrentOrg() ctx: RequestContext, @Query('limit') limit?: string) {
    return this.ledger.listJournals(ctx.organisationId, limit ? parseInt(limit, 10) : 50);
  }

  @Get('ledger/integrity')
  @RequireScopes(SCOPES.ADMIN)
  integrity(@CurrentOrg() ctx: RequestContext) {
    return this.ledger.integrityReport(ctx.organisationId);
  }

  @Get('journals/:id')
  @RequireScopes(SCOPES.ORGANISATIONS_READ)
  getJournal(@CurrentOrg() ctx: RequestContext, @Param('id') id: string) {
    return this.ledger.getJournal(ctx.organisationId, id);
  }
}
