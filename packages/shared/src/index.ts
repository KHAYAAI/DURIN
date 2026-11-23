/** Single source for the platform version reported by /health and /v1/version. */
export const DURIN_VERSION = '0.1.0';

/** Execution mode of any money-moving capability. */
export type ExecutionMode = 'sandbox' | 'live';

/**
 * Status labels used across docs, API metadata and dashboards.
 * `production-ready` must only be set after the release gates in the security docs.
 */
export const STATUS_LABELS = [
  'implemented',
  'simulated',
  'awaiting credentials',
  'awaiting commercial agreement',
  'awaiting regulatory approval',
  'production-ready',
] as const;
export type StatusLabel = (typeof STATUS_LABELS)[number];

export * from './webhook';
