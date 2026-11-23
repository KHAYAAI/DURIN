import { describe, expect, it } from 'vitest';
import { CHAIN_REGISTRY, assertChainAllowed, enabledPairs, evaluateDeposit, isValidAddress, listEnabledChains } from './chain-policy';

const prod = { ENABLED_CHAINS: '' } as NodeJS.ProcessEnv;
const usdcEth = CHAIN_REGISTRY.find((e) => e.assetCode === 'USDC' && e.chain === 'ethereum')!;
const usdcSol = CHAIN_REGISTRY.find((e) => e.assetCode === 'USDC' && e.chain === 'solana')!;

describe('chain policy', () => {
  it('production defaults to USDC on Ethereum and Solana only; USDT and testnets are off', () => {
    const on = [...enabledPairs(prod, false)].sort();
    expect(on).toEqual(['USDC:ethereum', 'USDC:solana']);
    expect(listEnabledChains(prod, false).every((e) => e.network === 'mainnet')).toBe(true);
  });

  it('USDT-on-Tron needs explicit enablement', () => {
    expect(() => assertChainAllowed('USDT', 'tron', prod, false)).toThrow();
    expect(assertChainAllowed('USDT', 'tron', { ENABLED_CHAINS: 'USDC:ethereum,USDT:tron' } as NodeJS.ProcessEnv, false).chain).toBe('tron');
  });

  it('refuses unknown assets/chains, a missing chain, and testnets in production even if listed', () => {
    expect(() => assertChainAllowed('USDC', 'polygon', prod, false)).toThrow();
    expect(() => assertChainAllowed('USDC', undefined, prod, false)).toThrow();
    expect(() => assertChainAllowed('USDC', 'ethereum-sepolia', { ENABLED_CHAINS: 'USDC:ethereum-sepolia' } as NodeJS.ProcessEnv, false)).toThrow();
  });

  it('sandbox additionally allows the test networks', () => {
    expect(assertChainAllowed('USDC', 'ethereum-sepolia', prod, true).network).toBe('testnet');
  });

  it('validates addresses per chain family', () => {
    expect(isValidAddress('evm', '0x00000000000000000000000000000000000000aa')).toBe(true);
    expect(isValidAddress('evm', '0x123')).toBe(false);
    expect(isValidAddress('solana', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).toBe(true);
    expect(isValidAddress('solana', '0x00000000000000000000000000000000000000aa')).toBe(false);
    expect(isValidAddress('tron', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')).toBe(true);
    expect(isValidAddress('tron', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6O')).toBe(false); // 'O' is not base58
  });

  describe('deposit evaluation', () => {
    const base = { assetCode: 'USDC', chain: 'ethereum', tokenContract: usdcEth.token, confirmations: usdcEth.confirmations };
    it('credits the native token once confirmed (EVM compare is case-insensitive)', () => {
      expect(evaluateDeposit(base, prod, false)).toEqual({ action: 'credit' });
      expect(evaluateDeposit({ ...base, tokenContract: usdcEth.token.toUpperCase().replace('0X', '0x') }, prod, false)).toEqual({ action: 'credit' });
    });
    it('waits until the confirmation depth is reached', () => {
      expect(evaluateDeposit({ ...base, confirmations: 3 }, prod, false)).toEqual({ action: 'wait', have: 3, need: 12 });
    });
    it('rejects a different token contract (look-alike) and bridged variants', () => {
      expect(evaluateDeposit({ ...base, tokenContract: '0x0000000000000000000000000000000000000bad' }, prod, false)).toEqual({ action: 'reject', reason: 'WRONG_TOKEN' });
      expect(evaluateDeposit({ ...base, tokenSymbol: 'USDC.e' }, prod, false)).toEqual({ action: 'reject', reason: 'BRIDGED_TOKEN' });
    });
    it('Solana mint comparison is case-sensitive', () => {
      const d = { assetCode: 'USDC', chain: 'solana', tokenContract: usdcSol.token, confirmations: 1 };
      expect(evaluateDeposit(d, prod, false)).toEqual({ action: 'credit' });
      expect(evaluateDeposit({ ...d, tokenContract: usdcSol.token.toLowerCase() }, prod, false)).toEqual({ action: 'reject', reason: 'WRONG_TOKEN' });
    });
    it('rejects deposits on chains that are not enabled', () => {
      expect(evaluateDeposit({ assetCode: 'USDT', chain: 'tron', tokenContract: 'x', confirmations: 99 }, prod, false)).toEqual({ action: 'reject', reason: 'CHAIN_NOT_ENABLED' });
    });
  });
});
