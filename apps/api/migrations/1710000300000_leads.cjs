exports.up = (pgm) => {
  pgm.createTable('leads', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    email: { type: 'text', notNull: true },
    full_name: { type: 'text', notNull: true },
    company_name: { type: 'text', notNull: true },
    phone: { type: 'text', notNull: true },
    revenue_band: { type: 'text', notNull: true },
    current_tool: { type: 'text', notNull: true },
    invoice_volume_band: { type: 'text', notNull: true },
    b2c_share: { type: 'text', notNull: true },
    erp: { type: 'text' },
    vat_registered: { type: 'boolean', notNull: true },
    source: { type: 'text', notNull: true, default: 'checker' },
    verdict: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
    ip: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('leads', 'email', { name: 'leads_email_idx' });
  pgm.createIndex('leads', 'created_at', { name: 'leads_created_at_idx' });
  pgm.sql(`GRANT SELECT, INSERT ON leads TO fawtara_app;`);
};
exports.down = (pgm) => {
  pgm.dropTable('leads');
};
