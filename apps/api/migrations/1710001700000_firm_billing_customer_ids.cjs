/**
 * EP5 Wave 2 (W2-E) — stripe_customer_id + paymob_customer_id on firms.
 *
 * Both columns are nullable: a firm can be created in dev/UAT without
 * BillingProvider credentials configured, in which case FirmBillingService
 * logs a warning and skips the provider call (see
 * apps/api/src/modules/billing/firm/billing.service.ts). The TODO(ep5-wave1)
 * handshake resolves to persisting whichever column matches the active
 * provider (`stripe` or `paymob`) on the firm row the webhook hook saw.
 *
 * No RLS change needed: `firms_self_isolation` already covers every
 * column via `USING (id = NULLIF(current_setting('app.firm_id', true), '')::uuid)`.
 */

exports.up = (pgm) => {
  pgm.addColumns('firms', {
    stripe_customer_id: { type: 'text' },
    paymob_customer_id: { type: 'text' },
  });
  // A firm has at most one customer id per provider. Partial unique
  // index skips the (common, nullable) blanks and gates against double
  // customer creation from a repeated webhook or a retried onFirmCreated.
  pgm.sql(
    `CREATE UNIQUE INDEX firms_stripe_customer_id_uniq
       ON firms (stripe_customer_id)
       WHERE stripe_customer_id IS NOT NULL;`,
  );
  pgm.sql(
    `CREATE UNIQUE INDEX firms_paymob_customer_id_uniq
       ON firms (paymob_customer_id)
       WHERE paymob_customer_id IS NOT NULL;`,
  );
};

exports.down = (pgm) => {
  pgm.sql(`DROP INDEX IF EXISTS firms_paymob_customer_id_uniq;`);
  pgm.sql(`DROP INDEX IF EXISTS firms_stripe_customer_id_uniq;`);
  pgm.dropColumns('firms', ['paymob_customer_id', 'stripe_customer_id']);
};
