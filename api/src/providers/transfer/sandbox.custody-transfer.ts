import { randomBytes } from 'crypto';
import { cmp } from '@durin/ledger';
import { sandboxCustody } from '../sandbox-custody';
import type { CustodyTransferParams, CustodyTransferPort, CustodyTransferResult } from './custody-transfer.port';

/** SIMULATED custody transfers between organisations (moves the in-process sandbox balances). */
export class SandboxCustodyTransferAdapter implements CustodyTransferPort {
  readonly name = 'sandbox-transfer';
  readonly mode = 'sandbox' as const;
  private done = new Map<string, CustodyTransferResult>();
  private fault?: 'fail' | 'throw_before' | 'throw_after';
  calls: string[] = [];
  injectFault(f: 'fail' | 'throw_before' | 'throw_after' | undefined, matching?: string) { this.fault = f; this.match = matching; }
  private match?: string;

  async move(p: CustodyTransferParams): Promise<CustodyTransferResult> {
    const prior = this.done.get(p.reference);
    if (prior) return prior;
    this.calls.push(p.reference);
    const faulty = this.fault && (!this.match || p.reference.startsWith(this.match)) ? this.fault : undefined;
    if (faulty) this.fault = undefined;
    if (faulty === 'throw_before') throw new Error('transfer timeout (not executed)');
    if (faulty === 'fail' || cmp(sandboxCustody.get(p.fromOrganisationId, p.assetCode), p.amount) < 0) {
      const r: CustodyTransferResult = { status: 'failed', reason: faulty === 'fail' ? 'TRANSFER_REJECTED' : 'INSUFFICIENT_CUSTODY' };
      this.done.set(p.reference, r); return r;
    }
    sandboxCustody.debit(p.fromOrganisationId, p.assetCode, p.amount);
    sandboxCustody.credit(p.toOrganisationId, p.assetCode, p.amount);
    const r: CustodyTransferResult = { status: 'completed', providerRef: `sbx_tr_${randomBytes(5).toString('hex')}` };
    this.done.set(p.reference, r);
    if (faulty === 'throw_after') throw new Error('transfer connection reset after execution');
    return r;
  }
}
