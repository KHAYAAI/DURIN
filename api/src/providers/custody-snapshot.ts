/** What a custodian reports for one organisation, and WHEN the custodian says it was true. */
export interface CustodySnapshot {
  /** The provider's own timestamp for the figures (not the time we asked). Stale snapshots are not evidence. */
  asOf: Date;
  balances: Array<{ assetCode: string; available: string }>;
}
