// Re-export of the firm-console billing webhook schema so Drizzle's
// typed client sees the table. The source lives in the module that
// owns it (apps/api/src/modules/billing/firm/webhook-event.entity.ts).
export { billingWebhookEvents, type BillingWebhookEvent } from '../../modules/billing/firm/webhook-event.entity';
