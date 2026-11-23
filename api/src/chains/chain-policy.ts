import { BadRequestException, UnprocessableEntityException } from '@nestjs/common';
import { isSandboxMode } from '../common/sandbox';

/**
 * Chain policy: which (asset, chain) pairs DURIN will create addresses for, send to, or credit
 * deposits from; how deep a deposit must be confirmed; and that only NATIVELY ISSUED tokens count.
 *
 * Token identifiers below are the issuers' published contract/mint addresses. They are config,
 * not code you should trust blindly: VERIFY each against the issuer's own documentation
 * (Circle: https://developers.circle.com/stablecoins/usdc-contract-addresses, Tether:
 * https://tether.to/en/supported-protocols/) before enabling a chain in production.
 */
export type ChainFamily = 'evm' | 'solana' | 'tron';

export interface ChainEntry {
  assetCode: 'USDC' | 'USDT';
  chain: string;
  family: ChainFamily;
  network: 'mainnet' | 'testnet';
  /** Native token contract / mint / TRC20 address. Anything else on this chain is NOT this asset. */
  token: string;
  decimals: number;
  /** Confirmations (EVM/Tron) or finalised depth (Solana uses 'finalized' commitment: 1). */
  confirmations: number;
}

export const CHAIN_REGISTRY: readonly ChainEntry[] = [
  { assetCode: 'USDC', chain: 'ethereum', family: 'evm', network: 'mainnet', token: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', decimals: 6, confirmations: 12 },
  { assetCode: 'USDC', chain: 'solana', family: 'solana', network: 'mainnet', token: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6, confirmations: 1 },
  { assetCode: 'USDT', chain: 'ethereum', family: 'evm', network: 'mainnet', token: '0xdac17f958d2ee523a2206206994597c13d831ec7', decimals: 6, confirmations: 12 },
  { assetCode: 'USDT', chain: 'tron', family: 'tron', network: 'mainnet', token: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', decimals: 6, confirmations: 19 },
  // Test networks (sandbox only).
  { assetCode: 'USDC', chain: 'ethereum-sepolia', family: 'evm', network: 'testnet', token: '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238', decimals: 6, confirmations: 3 },
  { assetCode: 'USDT', chain: 'ethereum-sepolia', family: 'evm', network: 'testnet', token: '0x0000000000000000000000000000000000000001', decimals: 6, confirmations: 3 },
  { assetCode: 'USDC', chain: 'solana-devnet', family: 'solana', network: 'testnet', token: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', decimals: 6, confirmations: 1 },
];

/** Pairs enabled by default on mainnet. USDT is deliberately NOT enabled until compliance signs off. */
export const DEFAULT_ENABLED = ['USDC:ethereum', 'USDC:solana'];

/** Wrapped/bridged variants that must never be credited as the native asset. */
const BRIDGED_SYMBOLS = /^(USDC|USDT)(\.e|\.b|\.wh|\.axl|-wormhole|-axelar|_e)$/i;

const key = (asset: string, chain: string) => `${asset.toUpperCase()}:${chain.toLowerCase()}`;

export function enabledPairs(env: NodeJS.ProcessEnv = process.env, sandbox = isSandboxMode()): Set<string> {
  const configured = (env.ENABLED_CHAINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const set = new Set((configured.length ? configured : DEFAULT_ENABLED).map((s) => key(...(s.split(':') as [string, string]))));
  for (const e of CHAIN_REGISTRY) {
    if (e.network !== 'testnet') continue;
    if (sandbox) set.add(key(e.assetCode, e.chain));
    else set.delete(key(e.assetCode, e.chain));
  }
  return set;
}

export function listEnabledChains(env: NodeJS.ProcessEnv = process.env, sandbox = isSandboxMode()) {
  const on = enabledPairs(env, sandbox);
  return CHAIN_REGISTRY.filter((e) => on.has(key(e.assetCode, e.chain)) && (sandbox || e.network === 'mainnet'));
}

/** Throws unless the pair is known, enabled for this environment, and (for fiat) has no chain. */
export function assertChainAllowed(assetCode: string, chain: string | undefined, env: NodeJS.ProcessEnv = process.env, sandbox = isSandboxMode()): ChainEntry {
  const asset = assetCode.toUpperCase();
  if (!chain) throw new BadRequestException({ code: 'CHAIN_REQUIRED', message: 'A chain is required for this asset.' });
  const entry = CHAIN_REGISTRY.find((e) => e.assetCode === asset && e.chain === chain.toLowerCase());
  if (!entry || !enabledPairs(env, sandbox).has(key(asset, chain)) || (!sandbox && entry.network !== 'mainnet')) {
    throw new UnprocessableEntityException({ code: 'CHAIN_NOT_ENABLED', message: `${asset} on ${chain} is not enabled.` });
  }
  return entry;
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
export function isValidAddress(family: ChainFamily, address: string): boolean {
  switch (family) {
    case 'evm': return /^0x[0-9a-fA-F]{40}$/.test(address);
    case 'solana': return address.length >= 32 && address.length <= 44 && BASE58.test(address);
    case 'tron': return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address);
  }
}

export function assertValidDestination(entry: ChainEntry, destination: string): void {
  if (!isValidAddress(entry.family, destination)) {
    throw new BadRequestException({ code: 'INVALID_ADDRESS', message: `Destination is not a valid ${entry.chain} address.` });
  }
}

export type DepositVerdict =
  | { action: 'credit' }
  | { action: 'wait'; have: number; need: number }
  | { action: 'reject'; reason: 'WRONG_TOKEN' | 'BRIDGED_TOKEN' | 'CHAIN_NOT_ENABLED' };

export interface DetectedDeposit {
  assetCode: string;
  chain: string;
  /** Contract / mint / TRC20 address of the token actually received. */
  tokenContract: string;
  /** Token symbol as reported by the chain/provider, if any (used to spot bridged variants). */
  tokenSymbol?: string;
  confirmations: number;
}

/** Decide whether a detected on-chain deposit may be credited. Pure; the caller persists the outcome. */
export function evaluateDeposit(d: DetectedDeposit, env: NodeJS.ProcessEnv = process.env, sandbox = isSandboxMode()): DepositVerdict {
  const entry = CHAIN_REGISTRY.find((e) => e.assetCode === d.assetCode.toUpperCase() && e.chain === d.chain.toLowerCase());
  if (!entry || !enabledPairs(env, sandbox).has(key(entry.assetCode, entry.chain)) || (!sandbox && entry.network !== 'mainnet')) {
    return { action: 'reject', reason: 'CHAIN_NOT_ENABLED' };
  }
  if (d.tokenSymbol && BRIDGED_SYMBOLS.test(d.tokenSymbol)) return { action: 'reject', reason: 'BRIDGED_TOKEN' };
  const same = entry.family === 'evm' ? d.tokenContract.toLowerCase() === entry.token : d.tokenContract === entry.token;
  if (!same) return { action: 'reject', reason: 'WRONG_TOKEN' };
  if (d.confirmations < entry.confirmations) return { action: 'wait', have: d.confirmations, need: entry.confirmations };
  return { action: 'credit' };
}
