import {
  Controller,
  ForbiddenException,
  Inject,
  NotFoundException,
  Optional,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { and, eq, isNull } from 'drizzle-orm';
import { DB, type Database } from '../../../db/db.module';
import { FirmGuard, type FirmAuthedRequest } from '../../../auth/firm.guard';
import { withFirm } from '../../../db/with-firm';
import { firmClientTenants } from '../../../db/schema/firms';
import { ImpersonationService } from './impersonation.service';

/**
 * Impersonation session the frontend consumes. Shape is intentionally
 * minimal — the UI reads `tenantId` to confirm which tenant the server
 * actually scoped to (it echoes the path param back but could, in
 * principle, differ) and `expiresAt` so the ImpersonationBanner can warn
 * before the session drops off.
 */
export interface ImpersonationTicket {
  tenantId: string;
  expiresAt: string;
}

/** Firm-member roles that are allowed to impersonate a client tenant. */
const IMPERSONATION_ALLOWED_ROLES = new Set(['owner', 'partner', 'staff']);

/**
 * POST /firms/:id/clients/:tenantId/act-as
 *
 * Starts an "act as this client" session for the signed-in firm member.
 *
 * Two-stage authorisation:
 *   1. FirmGuard already asserted the caller is a member of :id and
 *      attached `req.firmRole`.
 *   2. This controller then:
 *      - Verifies (firmId, tenantId) is a live firm_client_tenants link
 *        under the firm's RLS context. 404 otherwise.
 *      - Rejects read_only members. 403.
 *      - Writes a firm_impersonation_events row (the operational store
 *        TenantGuard reads on every subsequent impersonated request).
 *      - Emits `accountant.impersonation.started` so AuditSubscribers can
 *        append a firm_audit_events row (ClearTax §5.7 chain).
 *
 * Returns { tenantId, expiresAt } — the frontend uses expiresAt to
 * schedule an auto-exit before the session drops off.
 *
 * Why 404 and not 403 when the link does not exist: an attacker probing
 * for firm/tenant pairings should not be able to distinguish "tenant
 * exists but you are not linked" from "tenant does not exist". The
 * FirmGuard already validates firm membership; past it, every (tenant)
 * the firm does not have a live link to looks like "not found".
 */
@Controller('firms')
@UseGuards(FirmGuard)
export class ImpersonationController {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly impersonation: ImpersonationService,
    @Optional() private readonly events?: EventEmitter2,
  ) {}

  @Post(':id/clients/:tenantId/act-as')
  async start(
    @Req() req: FirmAuthedRequest,
    @Param('id', new ParseUUIDPipe()) _firmId: string,
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
  ): Promise<ImpersonationTicket> {
    void _firmId;
    const firmId = req.firmId!;
    const userId = req.userId!;
    const role = req.firmRole!;

    // Check (1): is this tenant currently linked to this firm?
    // The read runs inside withFirm so the firm_client_tenants RLS policy
    // gates it — a firm that somehow guessed another firm's tenantId
    // cannot see the row.
    const link = await withFirm(this.db, firmId, async (tx) => {
      const rows = await tx
        .select({ id: firmClientTenants.id })
        .from(firmClientTenants)
        .where(
          and(
            eq(firmClientTenants.firmId, firmId),
            eq(firmClientTenants.tenantId, tenantId),
            isNull(firmClientTenants.revokedAt),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    });
    if (!link) {
      throw new NotFoundException('Client tenant is not linked to this firm');
    }

    // Check (2): role gate. The frontend already hides the button for
    // read_only, but this is the defence in depth the client-side TODO
    // asked for.
    if (!IMPERSONATION_ALLOWED_ROLES.has(role)) {
      throw new ForbiddenException(
        `Firm role '${role}' is not permitted to impersonate client tenants`,
      );
    }

    // Grab IP + UA for the audit row. We stay off @types/express the way
    // the rest of the module does so the request shape is a MinimalRequest
    // extension; this helper reaches into the two fields safely.
    const { userAgent, ip } = extractClientContext(req);

    const session = await this.impersonation.start({
      firmId,
      clientTenantId: tenantId,
      userId,
      userAgent,
      ip,
    });

    // Fire-and-forget the AuditSubscribers event. Same timing as
    // FirmsService.createFirm: after the write has committed, before
    // the controller returns. The subscriber swallows its own failures,
    // so a down audit path never breaks the session itself.
    this.events?.emit('accountant.impersonation.started', {
      firmId,
      tenantId,
      actorUserId: userId,
      sessionId: session.id,
      expiresAt: session.expiresAt.toISOString(),
      originalRole: role,
    });

    return {
      tenantId,
      expiresAt: session.expiresAt.toISOString(),
    };
  }
}

/**
 * Pull User-Agent and caller IP off a MinimalRequest. Exported for the
 * controller unit tests; the two fields may be strings, arrays (Node
 * header shape) or undefined.
 */
export function extractClientContext(req: {
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
}): { userAgent: string | null; ip: string | null } {
  const uaHeader = req.headers['user-agent'];
  const userAgent =
    typeof uaHeader === 'string' ? uaHeader : Array.isArray(uaHeader) ? uaHeader[0] : null;
  // Prefer the first X-Forwarded-For hop (the real client, per the
  // ALB convention also used by ClearTaxPartnerGuard.extractCallerIp).
  const xff = req.headers['x-forwarded-for'];
  const xffFirst =
    typeof xff === 'string'
      ? (xff.split(',')[0]?.trim() ?? null)
      : Array.isArray(xff)
        ? (xff[0]?.split(',')[0]?.trim() ?? null)
        : null;
  const ip = xffFirst || req.socket?.remoteAddress || null;
  return { userAgent: userAgent ?? null, ip };
}
