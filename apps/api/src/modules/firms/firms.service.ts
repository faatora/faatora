import { randomBytes, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  OnModuleDestroy,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DB, type Database } from '../../db/db.module';
import { withFirm } from '../../db/with-firm';
import {
  firmClientTenants,
  firmInvitations,
  firmMemberships,
  firms,
  type FirmClientAccessLevel,
  type FirmEngagementType,
  type FirmMemberRole,
} from '../../db/schema/firms';
import { memberships, tenants, users } from '../../db/schema/tenancy';
import * as schema from '../../db/schema';
import { loadEnv } from '../../config/env';
import type {
  AddClientTenantDto,
  AddMemberDto,
  CreateClientTenantDto,
  CreateFirmDto,
  InviteMemberDto,
} from './dto/schemas';

export interface FirmRow {
  id: string;
  name: string;
  legalName: string | null;
  crNumber: string | null;
  country: string;
  vatin: string | null;
  email: string | null;
  phone: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface FirmMembershipRow {
  id: string;
  firmId: string;
  userId: string;
  role: FirmMemberRole;
  email: string;
  createdAt: Date;
}

export interface FirmClientTenantRow {
  id: string;
  firmId: string;
  tenantId: string;
  tenantName: string;
  accessLevel: FirmClientAccessLevel;
  engagementType: FirmEngagementType;
  createdAt: Date;
}

/**
 * Richer onboarding payload returned by createClientTenant. Carries the
 * CR number and VATIN that the wizard just captured so the frontend can
 * echo them back into the success screen without a second fetch.
 */
export interface ClientTenantRecord extends FirmClientTenantRow {
  crNumber: string;
  vatin: string;
  country: string;
  invitationId?: string;
}

/**
 * Per-client outcome of a batch onboard. Successful entries carry the
 * full ClientTenantRecord; failures carry the DTO index, the DTO itself
 * (so the frontend can surface a correctable form row), and a short
 * reason: one of 'duplicate' (idempotency key already present),
 * 'validation' (DTO failed a server-side check), 'conflict' (RLS/unique
 * violation), or 'error' (unexpected).
 */
export interface BatchOnboardFailure {
  index: number;
  dto: CreateClientTenantDto;
  error: string;
  reason: 'duplicate' | 'validation' | 'conflict' | 'error';
}

export interface BatchOnboardResult {
  created: ClientTenantRecord[];
  failed: BatchOnboardFailure[];
}

export interface PendingInvitationRow {
  id: string;
  firmId: string;
  email: string;
  role: FirmMemberRole;
  createdAt: Date;
  expiresAt: Date;
}

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * FirmsService — bare CRUD for the firm aggregate (EP5 Wave 1).
 *
 * Context propagation: every mutating op runs inside withFirm, so
 * `app.firm_id` is set for the transaction and RLS gates the write
 * through the firm_*_isolation policies.
 *
 * Two methods need to cross the firm_id boundary:
 *   - listMyFirms(userId)     — needs to enumerate all firms a user
 *                               is a member of, which requires reading
 *                               firm_memberships without knowing the
 *                               firm_id ahead of time.
 *   - acceptInvitation(token) — needs to resolve a token to a firm_id,
 *                               same chicken-and-egg problem.
 * Both use a short-lived pool bound to MIGRATION_DATABASE_URL (an
 * RLS-bypass path already established by ClearanceGatewayService and
 * documented in ADR-0002 D1). Every subsequent write runs under the
 * app pool with app.firm_id set, so RLS still gates the mutation.
 */
@Injectable()
export class FirmsService implements OnModuleDestroy {
  private readonly log = new Logger(FirmsService.name);
  private bypassPool: Pool | null = null;
  private bypassDb: NodePgDatabase<typeof schema> | null = null;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Optional() private readonly events?: EventEmitter2,
  ) {}

  async onModuleDestroy(): Promise<void> {
    if (this.bypassPool) {
      await this.bypassPool.end();
      this.bypassPool = null;
      this.bypassDb = null;
    }
  }

  /**
   * Lazily open (and memoise) the RLS-bypass pool. Follows the same
   * pattern as ClearanceGatewayService.getSweepPool. Returns null when
   * neither MIGRATION_DATABASE_URL nor DATABASE_URL is set.
   */
  private getBypassDb(): NodePgDatabase<typeof schema> | null {
    if (this.bypassDb) return this.bypassDb;
    const env = loadEnv();
    const url = env.MIGRATION_DATABASE_URL ?? env.DATABASE_URL;
    if (!url) return null;
    this.bypassPool = new Pool({ connectionString: url, max: 2 });
    this.bypassDb = drizzle(this.bypassPool, { schema });
    return this.bypassDb;
  }

  // -------------------------- firm CRUD --------------------------

  /**
   * Create a firm with the caller as its first `owner`.
   *
   * Timing of app.firm_id: we generate the id client-side (via
   * gen_random_uuid()) BEFORE the INSERT, SET LOCAL app.firm_id = id,
   * then insert. Both the firms INSERT WITH CHECK and the subsequent
   * firm_memberships INSERT pass RLS.
   */
  async createFirm(ownerUserId: string, dto: CreateFirmDto): Promise<FirmRow> {
    const created = await this.db.transaction(async (tx) => {
      const idRes = await tx.execute(sql`select gen_random_uuid() as id`);
      const firmId = (idRes.rows[0] as { id: string }).id;
      await tx.execute(sql`select set_config('app.firm_id', ${firmId}, true)`);

      const [row] = await tx
        .insert(firms)
        .values({
          id: firmId,
          name: dto.name,
          legalName: dto.legalName ?? null,
          crNumber: dto.crNumber ?? null,
          country: dto.country ?? 'OM',
          vatin: dto.vatin ?? null,
          email: dto.email ?? null,
          phone: dto.phone ?? null,
        })
        .returning();

      await tx.insert(firmMemberships).values({
        firmId: row.id,
        userId: ownerUserId,
        role: 'owner',
      });

      return this.mapFirm(row);
    });
    // EP5 Wave 2 (W2-E): emit AFTER the transaction commits so audit +
    // billing subscribers never observe a half-created firm. The hook is
    // fire-and-forget; subscriber failures do not undo the firm row.
    this.events?.emit('firm.created', {
      firmId: created.id,
      ownerUserId,
      firmName: created.name,
    });
    return created;
  }

  async getFirm(firmId: string): Promise<FirmRow | null> {
    return withFirm(this.db, firmId, async (tx) => {
      const rows = await tx.select().from(firms).where(eq(firms.id, firmId)).limit(1);
      return rows[0] ? this.mapFirm(rows[0]) : null;
    });
  }

  /**
   * Enumerate all firms the given user is an active member of. Uses
   * the RLS-bypass pool to find candidate firm_ids by user_id, then
   * reads each firm row under the app pool with the right app.firm_id
   * set — so firm rows returned to callers are ALWAYS the ones that
   * pass RLS, even if the bypass lookup over-returns.
   */
  async listMyFirms(userId: string): Promise<FirmRow[]> {
    const bypass = this.getBypassDb();
    if (!bypass) {
      this.log.warn('listMyFirms called without MIGRATION_DATABASE_URL; returning []');
      return [];
    }
    const candidates = await bypass
      .select({ firmId: firmMemberships.firmId })
      .from(firmMemberships)
      .where(and(eq(firmMemberships.userId, userId), isNull(firmMemberships.revokedAt)));
    if (candidates.length === 0) return [];
    const out: FirmRow[] = [];
    for (const c of candidates) {
      const firm = await this.getFirm(c.firmId);
      if (firm) out.push(firm);
    }
    // Stable order for consumers (and tests).
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  // -------------------------- members --------------------------

  async listMembers(firmId: string): Promise<FirmMembershipRow[]> {
    return withFirm(this.db, firmId, async (tx) => {
      const rows = await tx
        .select({
          id: firmMemberships.id,
          firmId: firmMemberships.firmId,
          userId: firmMemberships.userId,
          role: firmMemberships.role,
          email: users.email,
          createdAt: firmMemberships.createdAt,
        })
        .from(firmMemberships)
        .innerJoin(users, eq(users.id, firmMemberships.userId))
        .where(and(eq(firmMemberships.firmId, firmId), isNull(firmMemberships.revokedAt)));
      return rows.map((r) => ({
        id: r.id,
        firmId: r.firmId,
        userId: r.userId,
        role: r.role as FirmMemberRole,
        email: r.email,
        createdAt: r.createdAt,
      }));
    });
  }

  /**
   * Add a user directly (admin-op path). Ordinary onboarding goes
   * through inviteMember → acceptInvitation.
   */
  async addMember(firmId: string, dto: AddMemberDto): Promise<FirmMembershipRow> {
    return withFirm(this.db, firmId, async (tx) => {
      const userRows = await tx
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, dto.userId))
        .limit(1);
      if (!userRows[0]) throw new NotFoundException('User not found');

      const existing = await tx
        .select()
        .from(firmMemberships)
        .where(
          and(
            eq(firmMemberships.firmId, firmId),
            eq(firmMemberships.userId, dto.userId),
            isNull(firmMemberships.revokedAt),
          ),
        )
        .limit(1);
      if (existing[0]) throw new ConflictException('User is already a member of this firm');

      const [row] = await tx
        .insert(firmMemberships)
        .values({ firmId, userId: dto.userId, role: dto.role })
        .returning();
      return {
        id: row.id,
        firmId: row.firmId,
        userId: row.userId,
        role: row.role as FirmMemberRole,
        email: userRows[0].email,
        createdAt: row.createdAt,
      };
    });
  }

  async inviteMember(
    firmId: string,
    invitedByUserId: string,
    dto: InviteMemberDto,
  ): Promise<PendingInvitationRow & { token: string }> {
    return withFirm(this.db, firmId, async (tx) => {
      // Reject if the email already belongs to an active member.
      const existing = await tx
        .select({ id: firmMemberships.id })
        .from(firmMemberships)
        .innerJoin(users, eq(users.id, firmMemberships.userId))
        .where(
          and(
            eq(firmMemberships.firmId, firmId),
            eq(users.email, dto.email),
            isNull(firmMemberships.revokedAt),
          ),
        )
        .limit(1);
      if (existing[0]) throw new ConflictException('A member with that email already exists');

      // One-shot URL-safe token.
      const token = randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
      try {
        const [row] = await tx
          .insert(firmInvitations)
          .values({
            firmId,
            email: dto.email,
            role: dto.role,
            token,
            invitedByUserId,
            expiresAt,
          })
          .returning();
        return {
          id: row.id,
          firmId: row.firmId,
          email: row.email,
          role: row.role as FirmMemberRole,
          createdAt: row.createdAt,
          expiresAt: row.expiresAt,
          token,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/firm_invitations_firm_email_open_uniq/.test(msg)) {
          throw new ConflictException('An open invitation already exists for that email');
        }
        throw err;
      }
    });
  }

  /**
   * Accept an outstanding invitation.
   *
   * Flow:
   *   1. Resolve token → firm_id via the RLS-bypass pool. The token is
   *      already a cryptographic capability (32 bytes random), and the
   *      bypass read is scoped strictly to this one row.
   *   2. Verify expiry / not-already-accepted / not-revoked.
   *   3. Verify the accepting user's email matches the invitation (an
   *      extra guard against token reuse by a different account).
   *   4. Under withFirm, upsert the firm_memberships row and mark the
   *      invitation accepted — both writes gated by RLS.
   */
  async acceptInvitation(token: string, acceptingUserId: string): Promise<FirmMembershipRow> {
    const bypass = this.getBypassDb();
    if (!bypass) {
      throw new Error('MIGRATION_DATABASE_URL is required for invitation acceptance');
    }
    const invitation = await bypass.transaction(async (tx) => {
      const rows = await tx.execute(sql`
        SELECT id, firm_id, email, role, expires_at, accepted_at, revoked_at
          FROM firm_invitations
          WHERE token = ${token}
          LIMIT 1
      `);
      return rows.rows[0] as
        | {
            id: string;
            firm_id: string;
            email: string;
            role: string;
            expires_at: Date;
            accepted_at: Date | null;
            revoked_at: Date | null;
          }
        | undefined;
    });
    if (!invitation) throw new NotFoundException('Invitation not found');
    if (invitation.accepted_at) throw new ConflictException('Invitation already accepted');
    if (invitation.revoked_at) throw new ForbiddenException('Invitation revoked');
    if (new Date(invitation.expires_at).getTime() < Date.now()) {
      throw new ForbiddenException('Invitation expired');
    }

    return withFirm(this.db, invitation.firm_id, async (tx) => {
      const userRow = await tx
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(eq(users.id, acceptingUserId))
        .limit(1);
      if (!userRow[0]) throw new NotFoundException('Accepting user not found');
      if (userRow[0].email.toLowerCase() !== invitation.email.toLowerCase()) {
        throw new ForbiddenException('Invitation email does not match authenticated user');
      }

      let membershipRow;
      const existing = await tx
        .select()
        .from(firmMemberships)
        .where(
          and(
            eq(firmMemberships.firmId, invitation.firm_id),
            eq(firmMemberships.userId, acceptingUserId),
            isNull(firmMemberships.revokedAt),
          ),
        )
        .limit(1);
      if (existing[0]) {
        membershipRow = existing[0];
      } else {
        const [row] = await tx
          .insert(firmMemberships)
          .values({
            firmId: invitation.firm_id,
            userId: acceptingUserId,
            role: invitation.role as FirmMemberRole,
          })
          .returning();
        membershipRow = row;
      }

      await tx
        .update(firmInvitations)
        .set({ acceptedAt: new Date(), acceptedByUserId: acceptingUserId })
        .where(eq(firmInvitations.id, invitation.id));

      return {
        id: membershipRow.id,
        firmId: membershipRow.firmId,
        userId: membershipRow.userId,
        role: membershipRow.role as FirmMemberRole,
        email: userRow[0].email,
        createdAt: membershipRow.createdAt,
      };
    });
  }

  async revokeMember(firmId: string, userId: string): Promise<{ revoked: boolean }> {
    return withFirm(this.db, firmId, async (tx) => {
      const rows = await tx
        .update(firmMemberships)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(firmMemberships.firmId, firmId),
            eq(firmMemberships.userId, userId),
            isNull(firmMemberships.revokedAt),
          ),
        )
        .returning({ id: firmMemberships.id });
      return { revoked: rows.length > 0 };
    });
  }

  // -------------------------- client tenants --------------------------

  async addClientTenant(firmId: string, dto: AddClientTenantDto): Promise<FirmClientTenantRow> {
    return withFirm(this.db, firmId, async (tx) => {
      try {
        const [row] = await tx
          .insert(firmClientTenants)
          .values({
            firmId,
            tenantId: dto.tenantId,
            accessLevel: dto.accessLevel,
            engagementType: dto.engagementType,
          })
          .returning();
        // Tenant-name lookup: set app.tenant_id on this same transaction
        // so the tenants policy lets us read the row.
        await tx.execute(sql`select set_config('app.tenant_id', ${dto.tenantId}, true)`);
        const tName = await tx
          .select({ name: tenants.name })
          .from(tenants)
          .where(eq(tenants.id, dto.tenantId))
          .limit(1);
        await tx.execute(sql`select set_config('app.tenant_id', '', true)`);
        return {
          id: row.id,
          firmId: row.firmId,
          tenantId: row.tenantId,
          tenantName: tName[0]?.name ?? '',
          accessLevel: row.accessLevel as FirmClientAccessLevel,
          engagementType: row.engagementType as FirmEngagementType,
          createdAt: row.createdAt,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/firm_client_tenants_tenant_active_uniq/.test(msg)) {
          throw new ConflictException(
            'Tenant is already actively engaged by a firm. Revoke the existing link first.',
          );
        }
        if (/foreign key/i.test(msg) && /tenants/.test(msg)) {
          throw new BadRequestException('Tenant does not exist');
        }
        throw err;
      }
    });
  }

  async revokeClientTenant(
    firmId: string,
    tenantId: string,
    revokedByUserId?: string,
  ): Promise<{ revoked: boolean }> {
    const outcome = await withFirm(this.db, firmId, async (tx) => {
      const rows = await tx
        .update(firmClientTenants)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(firmClientTenants.firmId, firmId),
            eq(firmClientTenants.tenantId, tenantId),
            isNull(firmClientTenants.revokedAt),
          ),
        )
        .returning({ id: firmClientTenants.id });
      return { revoked: rows.length > 0 };
    });
    // Emit AFTER the transaction commits so subscribers never see a
    // partial state. W2-E's audit subscriber is the primary consumer.
    if (outcome.revoked && this.events) {
      this.events.emit('firm.client.revoked', { firmId, tenantId, revokedByUserId });
    }
    return outcome;
  }

  // -------------------------- onboarding (W2-C) --------------------------

  /**
   * Provision a brand-new client tenant AND the firm_client_tenants link
   * in a single transaction. This is the fast-path accountants use when
   * adding a client that doesn't yet exist in Faatora.
   *
   * Transaction order:
   *   1. SET app.firm_id (so firm_client_tenants INSERT passes RLS)
   *   2. Generate a new tenant uuid client-side
   *   3. SET app.tenant_id to that id (so the tenants self-isolation
   *      policy's WITH CHECK passes)
   *   4. INSERT the tenants row
   *   5. INSERT the firm_client_tenants link
   *   6. Optionally: upsert a users row + memberships row for the shop
   *      owner's email (role 'owner'), plus a firm_invitations row the
   *      accountant can forward manually. The invitation is firm-scoped
   *      so the token still works off the standard acceptInvitation
   *      path once the owner wants to self-serve.
   *   7. Reset app.tenant_id so the transaction's remaining work (if any)
   *      stays firm-scoped.
   *
   * Idempotency: callers who want to skip duplicates at the batch layer
   * should check (crNumber, vatin) up front. This method itself throws
   * ConflictException on a duplicate so unique-index violations surface
   * cleanly in the single-client path.
   */
  async createClientTenant(
    firmId: string,
    dto: CreateClientTenantDto,
    createdByUserId?: string,
  ): Promise<ClientTenantRecord> {
    const record = await withFirm(this.db, firmId, async (tx) => {
      // Duplicate guard: (crNumber, vatin) is the business idempotency
      // key. The `tenants` table's RLS policy does NOT have the firm
      // SELECT branch (ADR-0003 option a extends parties/invoices only),
      // so we cannot join across it from a firm context. Instead we walk
      // the firm's active client-tenant links and peek at each tenant's
      // vatin under its own app.tenant_id setting. This is a short loop
      // (dozens, not thousands, in the target persona).
      const linkedIds = await tx
        .select({ tenantId: firmClientTenants.tenantId })
        .from(firmClientTenants)
        .where(and(eq(firmClientTenants.firmId, firmId), isNull(firmClientTenants.revokedAt)));
      for (const link of linkedIds) {
        await tx.execute(sql`select set_config('app.tenant_id', ${link.tenantId}, true)`);
        const tRow = await tx
          .select({ vatin: tenants.vatin })
          .from(tenants)
          .where(eq(tenants.id, link.tenantId))
          .limit(1);
        if (tRow[0] && tRow[0].vatin === dto.vatin) {
          // Reset before throwing so the rolled-back transaction leaves
          // a clean setting on the connection.
          await tx.execute(sql`select set_config('app.tenant_id', '', true)`);
          throw new ConflictException(
            `A client with VATIN ${dto.vatin} is already onboarded to this firm`,
          );
        }
      }
      // Reset tenant context before the new-tenant INSERT below picks it
      // back up for the fresh tenantId.
      await tx.execute(sql`select set_config('app.tenant_id', '', true)`);

      const tenantId = randomUUID();
      // Flip tenant context so the tenants-self-isolation WITH CHECK
      // passes for this one INSERT. See createFirm for the mirror pattern
      // with app.firm_id.
      await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
      await tx.insert(tenants).values({
        id: tenantId,
        name: dto.tenantName,
        vatin: dto.vatin,
      });

      // Link row (still under app.firm_id from withFirm).
      let linkRow;
      try {
        const [row] = await tx
          .insert(firmClientTenants)
          .values({
            firmId,
            tenantId,
            accessLevel: dto.accessLevel,
            engagementType: dto.engagementType,
          })
          .returning();
        linkRow = row;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/firm_client_tenants_tenant_active_uniq/.test(msg)) {
          throw new ConflictException(
            'Tenant is already actively engaged by a firm. Revoke the existing link first.',
          );
        }
        throw err;
      }

      // Optional: provision a pending user + tenant membership + a
      // firm-scoped invitation. The users row has no RLS; memberships
      // does, and we're still inside the tenant context from step (3).
      let invitationId: string | undefined;
      if (dto.shopOwnerEmail) {
        const existing = await tx.execute(
          sql`SELECT id FROM users WHERE email = ${dto.shopOwnerEmail} LIMIT 1`,
        );
        let userId = (existing.rows[0] as { id: string } | undefined)?.id;
        if (!userId) {
          // Placeholder cognito_sub; a later real-signup collision is
          // resolved by the auth adapter rewriting this row. The sub is
          // namespaced so it is obviously a placeholder.
          userId = randomUUID();
          const placeholderSub = `pending:${userId}`;
          await tx.execute(
            sql`INSERT INTO users (id, cognito_sub, email) VALUES (${userId}, ${placeholderSub}, ${dto.shopOwnerEmail})`,
          );
        }
        await tx
          .insert(memberships)
          .values({ tenantId, userId, role: 'owner' })
          .onConflictDoNothing();
        // Flip back to firm context so we can insert the invitation row,
        // which is firm-scoped.
        await tx.execute(sql`select set_config('app.tenant_id', '', true)`);
        const token = randomBytes(32).toString('base64url');
        const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
        try {
          const [inviteRow] = await tx
            .insert(firmInvitations)
            .values({
              firmId,
              email: dto.shopOwnerEmail,
              // The shop owner is onboarded as a tenant-level owner, not
              // a firm member. The invitation role field here records the
              // weakest firm-side capability so the invite cannot be
              // reused to grab firm-side access if the accountant later
              // forwards it by mistake.
              role: 'read_only',
              token,
              invitedByUserId: createdByUserId ?? null,
              expiresAt,
            })
            .returning();
          invitationId = inviteRow.id;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // Don't fail the whole onboarding because of a duplicate open
          // invite: the client tenant is the primary artifact.
          if (!/firm_invitations_firm_email_open_uniq/.test(msg)) throw err;
        }
      } else {
        // No shop-owner email: clear tenant context explicitly for any
        // subsequent work inside this transaction.
        await tx.execute(sql`select set_config('app.tenant_id', '', true)`);
      }

      return {
        id: linkRow.id,
        firmId: linkRow.firmId,
        tenantId: linkRow.tenantId,
        tenantName: dto.tenantName,
        accessLevel: linkRow.accessLevel as FirmClientAccessLevel,
        engagementType: linkRow.engagementType as FirmEngagementType,
        createdAt: linkRow.createdAt,
        crNumber: dto.crNumber,
        vatin: dto.vatin,
        country: dto.country ?? 'OM',
        invitationId,
      } satisfies ClientTenantRecord;
    });

    // Emit AFTER the transaction has committed. W2-E listens for this
    // on the audit side and (separately) on the billing side for seat
    // counting. Firing from inside the transaction would leak writes
    // that later rollback.
    if (this.events) {
      this.events.emit('firm.client.added', {
        firmId: record.firmId,
        tenantId: record.tenantId,
        createdByUserId,
      });
    }
    return record;
  }

  /**
   * Batch variant. Each client is tried on its own transaction so one
   * duplicate doesn't poison the whole import. The method applies an
   * in-memory idempotency filter on (crNumber, vatin) BEFORE touching
   * the DB so a CSV with repeated rows doesn't need round-trips to be
   * deduped.
   *
   * Returns both the created records and a structured failure list so
   * the UI can show a per-row outcome table.
   */
  async createClientTenantsBatch(
    firmId: string,
    clients: CreateClientTenantDto[],
    createdByUserId?: string,
  ): Promise<BatchOnboardResult> {
    if (clients.length === 0) {
      return { created: [], failed: [] };
    }
    if (clients.length > 50) {
      throw new BadRequestException('Batch onboard is capped at 50 clients per call');
    }

    const created: ClientTenantRecord[] = [];
    const failed: BatchOnboardFailure[] = [];

    // In-memory dedup pass on (crNumber, vatin). Later duplicates in the
    // same payload resolve to the first occurrence.
    const seen = new Map<string, number>();
    for (let i = 0; i < clients.length; i++) {
      const c = clients[i];
      const key = `${c.crNumber.trim().toLowerCase()}|${c.vatin.trim().toLowerCase()}`;
      if (seen.has(key)) {
        failed.push({
          index: i,
          dto: c,
          error: `duplicate of row ${seen.get(key)} in this batch (same CR + VATIN)`,
          reason: 'duplicate',
        });
        continue;
      }
      seen.set(key, i);

      try {
        const record = await this.createClientTenant(firmId, c, createdByUserId);
        created.push(record);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        let reason: BatchOnboardFailure['reason'] = 'error';
        if (err instanceof ConflictException) reason = 'duplicate';
        else if (err instanceof BadRequestException) reason = 'validation';
        else if (err instanceof ForbiddenException) reason = 'conflict';
        failed.push({ index: i, dto: c, error: msg, reason });
      }
    }

    return { created, failed };
  }

  async listClientTenants(firmId: string): Promise<FirmClientTenantRow[]> {
    return withFirm(this.db, firmId, async (tx) => {
      const links = await tx
        .select()
        .from(firmClientTenants)
        .where(and(eq(firmClientTenants.firmId, firmId), isNull(firmClientTenants.revokedAt)));
      if (links.length === 0) return [];
      const results: FirmClientTenantRow[] = [];
      for (const link of links) {
        // Per-link tenant-name lookup — see note on addClientTenant.
        // Wave 2 replaces this with a `tenants_firm_read` policy.
        await tx.execute(sql`select set_config('app.tenant_id', ${link.tenantId}, true)`);
        const tRows = await tx
          .select({ name: tenants.name })
          .from(tenants)
          .where(eq(tenants.id, link.tenantId))
          .limit(1);
        results.push({
          id: link.id,
          firmId: link.firmId,
          tenantId: link.tenantId,
          tenantName: tRows[0]?.name ?? '',
          accessLevel: link.accessLevel as FirmClientAccessLevel,
          engagementType: link.engagementType as FirmEngagementType,
          createdAt: link.createdAt,
        });
      }
      await tx.execute(sql`select set_config('app.tenant_id', '', true)`);
      results.sort((a, b) => a.tenantName.localeCompare(b.tenantName));
      return results;
    });
  }

  // -------------------------- helpers --------------------------

  private mapFirm(r: typeof firms.$inferSelect): FirmRow {
    return {
      id: r.id,
      name: r.name,
      legalName: r.legalName,
      crNumber: r.crNumber,
      country: r.country,
      vatin: r.vatin,
      email: r.email,
      phone: r.phone,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }
}
