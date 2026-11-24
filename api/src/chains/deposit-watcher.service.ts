import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown, Optional, Inject } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RejectedDepositsService } from '../compliance/rejected-deposits.service';
import { WalletsService } from '../wallets/wallets.service';
import { CHAIN_REGISTRY } from './chain-policy';
import { SolanaRpc, type ParsedTx } from './solana-rpc';

export const SOLANA_RPC = Symbol('SOLANA_RPC');
const PAGE = 100;
const MAX_PAGES = 10;

export const watcherStatus = { lastSuccessAt: 0, lastError: '' as string };

/** Converts a base-unit integer string to a decimal string. */
function fromUnits(units: bigint, decimals: number): string {
  const s = units.toString().padStart(decimals + 1, '0');
  const i = s.slice(0, s.length - decimals);
  const f = s.slice(s.length - decimals).replace(/0+$/, '');
  return f ? `${i}.${f}` : i;
}

/**
 * Solana deposit watcher. OpenFireblocks emits no inbound-deposit event, so DURIN reads the chain
 * itself: for every active Solana deposit address it lists the owner's SPL token accounts, walks new
 * FINALIZED transactions for each, derives the amount received from the token-balance change (never
 * from instruction text), and hands it to `WalletsService.recordDetectedDeposit`, which applies the
 * chain policy (native mint only, bridged/look-alike rejected and audited) and credits exactly once
 * per (address, tx).
 *
 * Safety properties:
 *  - Only `finalized` data is read; credits are idempotent, so overlapping ticks or restarts are safe.
 *  - The cursor advances only past transactions that were processed successfully; any RPC error stops
 *    that token account for this tick and it is retried next time (a deposit is delayed, never skipped).
 *  - Only positive balance changes of the address's own token account count as deposits; failed
 *    transactions are ignored.
 */
@Injectable()
export class DepositWatcherService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger(DepositWatcherService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly wallets: WalletsService,
    private readonly rejected: RejectedDepositsService,
    @Optional() @Inject(SOLANA_RPC) private readonly rpcOverride?: SolanaRpc,
  ) {}

  onApplicationBootstrap() {
    const seconds = Number(process.env.DEPOSIT_WATCHER_INTERVAL_SECONDS ?? 0);
    if (!(seconds > 0) || process.env.NODE_ENV === 'test') return;
    if (!this.rpc()) { this.log.error('DEPOSIT_WATCHER_INTERVAL_SECONDS is set but SOLANA_RPC_URL is not: deposits will NOT be detected'); return; }
    this.timer = setInterval(() => void this.tick(), seconds * 1000);
    this.timer.unref();
    this.log.log(`Solana deposit watcher every ${seconds}s`);
  }

  onApplicationShutdown() { if (this.timer) clearInterval(this.timer); }

  private rpc(): SolanaRpc | undefined {
    if (this.rpcOverride) return this.rpcOverride;
    const url = process.env.SOLANA_RPC_URL;
    if (!url) return undefined;
    const key = process.env.SOLANA_RPC_API_KEY;
    return new SolanaRpc({ url, headers: key ? { Authorization: `Bearer ${key}` } : undefined });
  }

  /** One pass over all active Solana deposit addresses. Returns how many deposits were credited. */
  async tick(): Promise<{ credited: number; errors: number }> {
    if (this.running) return { credited: 0, errors: 0 };
    const rpc = this.rpc();
    if (!rpc) return { credited: 0, errors: 0 };
    this.running = true;
    let credited = 0, errors = 0;
    try {
      const addresses = await this.prisma.depositAddress.findMany({ where: { status: 'active', chain: { in: ['solana', 'solana-devnet'] } } });
      for (const addr of addresses) {
        try { credited += await this.scanAddress(rpc, addr); } catch (e) {
          errors++;
          watcherStatus.lastError = e instanceof Error ? e.message : String(e);
          this.log.error(`Deposit scan failed for address ${addr.id}: ${watcherStatus.lastError}`);
        }
      }
      if (errors === 0) { watcherStatus.lastSuccessAt = Date.now(); watcherStatus.lastError = ''; }
    } finally { this.running = false; }
    return { credited, errors };
  }

  private async scanAddress(rpc: SolanaRpc, addr: { id: string; organisationId: string; address: string; assetCode: string; chain: string }): Promise<number> {
    const entry = CHAIN_REGISTRY.find((e) => e.assetCode === addr.assetCode && e.chain === addr.chain);
    if (!entry) return 0;
    const accounts = await rpc.tokenAccountsByOwner(addr.address);
    let credited = 0;
    for (const acct of accounts) {
      const cursor = await this.prisma.chainCursor.findUnique({ where: { depositAddressId_tokenAccount: { depositAddressId: addr.id, tokenAccount: acct.pubkey } } });
      // Collect every signature newer than the cursor (newest first), paging back.
      const fresh: string[] = [];
      let before: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const sigs = await rpc.signatures(acct.pubkey, { until: cursor?.lastSignature, before, limit: PAGE });
        for (const s of sigs) if (!s.err) fresh.push(s.signature);
        if (sigs.length < PAGE) { before = undefined; break; }
        before = sigs[sigs.length - 1]!.signature;
        if (page === MAX_PAGES - 1) throw new Error(`more than ${PAGE * MAX_PAGES} new transactions on ${acct.pubkey}; refusing to skip any`);
      }
      // Oldest first, so the cursor only ever moves past processed transactions.
      let advancedTo: string | undefined;
      for (const sig of fresh.reverse()) {
        const tx = await rpc.transaction(sig);
        if (tx === null) break; // not yet retrievable: retry next tick, do not advance
        const units = this.receivedUnits(tx, acct.pubkey, acct.mint);
        if (units > 0n) {
          if (acct.mint !== entry.token) {
            // Not this asset's native mint (look-alike, bridged or spam token). Never credited; recorded for ops.
            await this.rejected.record({
              organisationId: addr.organisationId, depositAddressId: addr.id, chain: addr.chain, txHash: sig, tokenContract: acct.mint,
              baseUnits: units.toString(), decimals: this.decimalsOf(tx, acct.pubkey) ?? null, reason: 'WRONG_TOKEN', sender: this.senderOf(tx, acct.mint, acct.pubkey),
            });
          } else {
            const result = await this.wallets.recordDetectedDeposit(addr.organisationId, addr.id, {
              txHash: sig, amount: fromUnits(units, entry.decimals), tokenContract: acct.mint, confirmations: entry.confirmations,
              sender: this.senderOf(tx, acct.mint, acct.pubkey),
            });
            if (result.status === 'credited') credited++;
          }
        }
        advancedTo = sig;
      }
      if (advancedTo) {
        await this.prisma.chainCursor.upsert({
          where: { depositAddressId_tokenAccount: { depositAddressId: addr.id, tokenAccount: acct.pubkey } },
          create: { depositAddressId: addr.id, tokenAccount: acct.pubkey, lastSignature: advancedTo },
          update: { lastSignature: advancedTo },
        });
      }
    }
    return credited;
  }

  /** Net positive change of the token account's balance in this transaction, in base units. */
  private receivedUnits(tx: ParsedTx, tokenAccount: string, mint: string): bigint {
    if (!tx.meta || tx.meta.err) return 0n;
    const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey));
    const idx = keys.indexOf(tokenAccount);
    if (idx < 0) return 0n;
    const pick = (list?: Array<{ accountIndex: number; mint: string; uiTokenAmount: { amount: string } }>) =>
      list?.find((b) => b.accountIndex === idx && b.mint === mint);
    const pre = BigInt(pick(tx.meta.preTokenBalances)?.uiTokenAmount.amount ?? '0');
    const post = BigInt(pick(tx.meta.postTokenBalances)?.uiTokenAmount.amount ?? '0');
    return post > pre ? post - pre : 0n;
  }

  /** Owner of the token account whose balance of this mint DECREASED in the transaction (the sender), if unambiguous. */
  private senderOf(tx: ParsedTx, mint: string, ownTokenAccount: string): string | undefined {
    const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey));
    const own = keys.indexOf(ownTokenAccount);
    const pre = tx.meta?.preTokenBalances ?? []; const post = tx.meta?.postTokenBalances ?? [];
    const senders = pre.filter((b) => b.mint === mint && b.accountIndex !== own && b.owner).filter((b) => {
      const after = post.find((p) => p.accountIndex === b.accountIndex);
      return after && BigInt(after.uiTokenAmount.amount) < BigInt(b.uiTokenAmount.amount);
    });
    const owners = new Set(senders.map((b) => b.owner as string));
    return owners.size === 1 ? [...owners][0] : undefined;
  }

  private decimalsOf(tx: ParsedTx, tokenAccount: string): number | undefined {
    const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey));
    const idx = keys.indexOf(tokenAccount);
    return tx.meta?.postTokenBalances?.find((b) => b.accountIndex === idx)?.uiTokenAmount.decimals;
  }
}
