import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WalletsService } from '../wallets/wallets.service';
import { RejectedDepositsService } from '../compliance/rejected-deposits.service';
import { CHAIN_REGISTRY } from './chain-policy';
import { EvmRpc, type EvmLog } from './evm-rpc';

export const EVM_RPC = Symbol('EVM_RPC');
const RANGE = 2000;           // blocks per eth_getLogs call (providers cap this)
const MAX_RANGES = 20;        // per address per tick
const CURSOR_KEY = 'evm-logs';
export const evmWatcherStatus = { lastSuccessAt: 0, lastError: '' as string };

function fromUnits(units: bigint, decimals: number): string {
  const s = units.toString().padStart(decimals + 1, '0');
  const i = s.slice(0, s.length - decimals); const f = s.slice(s.length - decimals).replace(/0+$/, '');
  return f ? `${i}.${f}` : i;
}

/**
 * Ethereum deposit watcher: ERC-20 Transfer events to each active Ethereum deposit address, read from
 * FINALIZED blocks only. The native token (per chain registry) is credited through the chain policy; any other
 * token contract is recorded as a rejected deposit (never credited). The block cursor advances only after a whole
 * range was processed, so an RPC failure delays deposits but cannot skip one. Credits are idempotent per (address, tx:logIndex).
 */
@Injectable()
export class EvmDepositWatcherService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger(EvmDepositWatcherService.name);
  private timer?: NodeJS.Timeout; private running = false;

  constructor(
    private readonly prisma: PrismaService, private readonly wallets: WalletsService, private readonly rejected: RejectedDepositsService,
    @Optional() @Inject(EVM_RPC) private readonly rpcOverride?: EvmRpc,
  ) {}

  private rpc(): EvmRpc | undefined {
    if (this.rpcOverride) return this.rpcOverride;
    const url = process.env.EVM_RPC_URL; if (!url) return undefined;
    const key = process.env.EVM_RPC_API_KEY;
    return new EvmRpc({ url, headers: key ? { Authorization: `Bearer ${key}` } : undefined });
  }

  onApplicationBootstrap() {
    const seconds = Number(process.env.DEPOSIT_WATCHER_INTERVAL_SECONDS ?? 0);
    if (!(seconds > 0) || process.env.NODE_ENV === 'test') return;
    if (!this.rpc()) { this.log.warn('EVM deposit watcher not started: EVM_RPC_URL is not set'); return; }
    this.timer = setInterval(() => void this.tick(), seconds * 1000); this.timer.unref();
  }
  onApplicationShutdown() { if (this.timer) clearInterval(this.timer); }

  async tick(): Promise<{ credited: number; errors: number }> {
    const rpc = this.rpc();
    if (!rpc || this.running) return { credited: 0, errors: 0 };
    this.running = true; let credited = 0, errors = 0;
    try {
      const finalized = await rpc.finalizedBlock();
      const addrs = await this.prisma.depositAddress.findMany({ where: { status: 'active', chain: { in: ['ethereum', 'ethereum-sepolia'] } } });
      for (const a of addrs) {
        try { credited += await this.scan(rpc, a, finalized); } catch (e) {
          errors++; evmWatcherStatus.lastError = e instanceof Error ? e.message : String(e);
          this.log.error(`EVM deposit scan failed for ${a.id}: ${evmWatcherStatus.lastError}`);
        }
      }
      if (errors === 0) { evmWatcherStatus.lastSuccessAt = Date.now(); evmWatcherStatus.lastError = ''; }
    } catch (e) {
      errors++; evmWatcherStatus.lastError = e instanceof Error ? e.message : String(e);
    } finally { this.running = false; }
    return { credited, errors };
  }

  private async scan(rpc: EvmRpc, a: { id: string; organisationId: string; address: string; assetCode: string; chain: string }, finalized: number): Promise<number> {
    const entry = CHAIN_REGISTRY.find((e) => e.assetCode === a.assetCode && e.chain === a.chain);
    if (!entry) return 0;
    const cur = await this.prisma.chainCursor.findUnique({ where: { depositAddressId_tokenAccount: { depositAddressId: a.id, tokenAccount: CURSOR_KEY } } });
    let from = cur ? Number(cur.lastSignature) + 1 : Math.max(0, finalized - Number(process.env.EVM_INITIAL_LOOKBACK_BLOCKS ?? 2000));
    let credited = 0;
    for (let n = 0; n < MAX_RANGES && from <= finalized; n++) {
      const to = Math.min(finalized, from + RANGE - 1);
      const logs = (await rpc.transfersTo(a.address, from, to)).sort((x, y) => Number(BigInt(x.blockNumber) - BigInt(y.blockNumber)) || Number(BigInt(x.logIndex) - BigInt(y.logIndex)));
      for (const l of logs) credited += await this.handle(a, entry, l);
      await this.prisma.chainCursor.upsert({
        where: { depositAddressId_tokenAccount: { depositAddressId: a.id, tokenAccount: CURSOR_KEY } },
        create: { depositAddressId: a.id, tokenAccount: CURSOR_KEY, lastSignature: String(to) }, update: { lastSignature: String(to) },
      });
      from = to + 1;
    }
    return credited;
  }

  private async handle(a: { id: string; organisationId: string; address: string; chain: string }, entry: { token: string; decimals: number; confirmations: number }, l: EvmLog): Promise<number> {
    const units = BigInt(l.data);
    if (units <= 0n || l.topics.length !== 3) return 0; // zero-value or non-ERC-20 (e.g. ERC-721 has 4 topics) transfer
    const txKey = `${l.transactionHash}:${BigInt(l.logIndex)}`;
    const sender = `0x${l.topics[1]!.slice(26)}`;
    const token = l.address.toLowerCase();
    if (token !== entry.token) {
      await this.rejected.record({ organisationId: a.organisationId, depositAddressId: a.id, chain: a.chain, txHash: txKey, tokenContract: token, baseUnits: units.toString(), reason: 'WRONG_TOKEN', sender });
      return 0;
    }
    const r = await this.wallets.recordDetectedDeposit(a.organisationId, a.id, {
      txHash: txKey, amount: fromUnits(units, entry.decimals), tokenContract: token, confirmations: entry.confirmations, sender, baseUnits: units.toString(),
    });
    return r.status === 'credited' ? 1 : 0;
  }
}
