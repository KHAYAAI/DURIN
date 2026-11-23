/** Event types DURIN can emit. `*` subscribes an endpoint to all of them. */
export const WEBHOOK_EVENT_TYPES = [
  'payment_intent.settled',
  'conversion.settled',
  'conversion.failed',
  'withdrawal.confirmed',
  'withdrawal.submitted',
  'withdrawal.failed',
  'withdrawal.processing',
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];
