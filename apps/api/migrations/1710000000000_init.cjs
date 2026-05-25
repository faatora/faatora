/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  // gen_random_uuid(); tenant tables + RLS policies arrive in the EP2 migration.
  pgm.createExtension('pgcrypto', { ifNotExists: true });
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropExtension('pgcrypto', { ifNotExists: true });
};
