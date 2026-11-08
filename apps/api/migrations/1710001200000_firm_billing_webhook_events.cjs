exports.up = (pgm) => {
  // billing_webhook_events — idempotency store for inbound provider
  // webhooks (Stripe today; Paddle/2Checkout later). Not tenant-scoped:
  // webhook events are provider-side and arrive before we necessarily
  // know a tenant. Idempotency is enforced by the UNIQUE index on
  // (provider, provider_event_id).
  pgm.createTable('billing_webhook_events', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    provider: { type: 'text', notNull: true },
    provider_event_id: { type: 'text', notNull: true },
    event_type: { type: 'text', notNull: true },
    received_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    processed_at: { type: 'timestamptz' },
    payload: { type: 'jsonb', notNull: true },
  });
  pgm.addConstraint('billing_webhook_events', 'billing_webhook_events_provider_event_uniq', {
    unique: ['provider', 'provider_event_id'],
  });
  pgm.createIndex('billing_webhook_events', 'event_type', {
    name: 'billing_webhook_events_type_idx',
  });
};

exports.down = (pgm) => {
  pgm.dropTable('billing_webhook_events');
};
