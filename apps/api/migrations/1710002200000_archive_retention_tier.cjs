/**
 * ClearTax §5.7 declared-subcontractor commitment — 10-year archival.
 *
 * Adds per-object retention tracking to archive_records so the API layer
 * knows which S3 storage class an object is in without a per-request S3
 * HeadObject (which would be a cold-call and $$$ on GLACIER_IR tiers).
 *
 * Columns:
 *   - retention_tier TEXT NOT NULL DEFAULT 'STANDARD'
 *       One of 'STANDARD' (hot, year 0-5) or 'GLACIER_IR' (Glacier Instant
 *       Retrieval, year 5-10). GLACIER_IR costs ~2x the per-GET of STANDARD
 *       but is still a synchronous GetObject with no restore step, so the
 *       archive reader does not need a special path (see ArchiveService and
 *       apps/api/src/modules/archive/glacier-reader.ts).
 *   - retention_until_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '10 years')
 *       Point-in-time deletion is permitted at. This mirrors
 *       infra/modules/archive/main.tf's Lifecycle Expiration rule at 3650
 *       days and the S3 Object Lock retain-until date. Stored as timestamptz
 *       (not a date) so bucket policy time-math lines up to the second.
 *
 * OTA rule implemented: Fawtara §5.7 retention — 5 years operational + 5
 * years cold archive = 10 years total from the signing / clearance date.
 * The current archive_records.retention_until column is a plain DATE and
 * fine for human display; this new timestamp is what the API checks to
 * decide whether an object is still within either tier.
 *
 * Reversible via dropColumns in `down`.
 *
 * NOTE: existing rows are backfilled by the column defaults — retention_tier
 * = STANDARD, retention_until_at = now() + 10 years. Existing rows were
 * written under the old 5-year window; a one-shot script to re-stamp them
 * against archived_at + 10 years is tracked in the PR body under "Manual
 * follow-ups" and NOT run inside this migration.
 */

exports.up = (pgm) => {
  pgm.addColumns('archive_records', {
    retention_tier: {
      type: 'text',
      notNull: true,
      default: 'STANDARD',
    },
    retention_until_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func(`now() + interval '10 years'`),
    },
  });
  pgm.addConstraint('archive_records', 'archive_records_retention_tier_check', {
    check: "retention_tier IN ('STANDARD','GLACIER_IR')",
  });
  // Lookups the archive reader does: "give me every object past its tier
  // transition date so we can prewarm the retrieval metrics". Index both
  // the tier and the until-date together so the planner can plan either.
  pgm.createIndex('archive_records', ['tenant_id', 'retention_tier'], {
    name: 'archive_records_tenant_tier_idx',
  });
  pgm.createIndex('archive_records', 'retention_until_at', {
    name: 'archive_records_retention_until_idx',
  });
};

exports.down = (pgm) => {
  pgm.dropIndex('archive_records', null, {
    name: 'archive_records_retention_until_idx',
    ifExists: true,
  });
  pgm.dropIndex('archive_records', null, {
    name: 'archive_records_tenant_tier_idx',
    ifExists: true,
  });
  pgm.dropConstraint('archive_records', 'archive_records_retention_tier_check', {
    ifExists: true,
  });
  pgm.dropColumns('archive_records', ['retention_tier', 'retention_until_at']);
};
