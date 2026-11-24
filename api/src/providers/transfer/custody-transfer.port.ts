/**
 * Moves value between two DURIN organisations' custody (customer ⇄ house) — the physical counterpart of the
 * house journals. Implementations MUST be idempotent per `reference`. A thrown error means the outcome is UNKNOWN.
 * No live implementation exists yet: with the sandbox implementation, house dealing/netting cannot run in production.
 */
export interface CustodyTransferParams { fromOrganisationId: string; toOrganisationId: string; assetCode: string; amount: string; reference: string }
export interface CustodyTransferResult { status: 'completed' | 'failed'; providerRef?: string; reason?: string }
export interface CustodyTransferPort {
  readonly name: string;
  readonly mode: 'sandbox' | 'live';
  move(p: CustodyTransferParams): Promise<CustodyTransferResult>;
}
export const CUSTODY_TRANSFER_PORT = Symbol('CUSTODY_TRANSFER_PORT');
