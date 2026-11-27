import { Controller, Get, Param, ParseUUIDPipe, Query, Req, UseGuards } from '@nestjs/common';
import { FirmGuard, type FirmAuthedRequest } from '../../auth/firm.guard';
import { ClearTaxPartnerGuard } from '../../auth/cleartax-partner.guard';
import { AuditService, type AuditChainVerification, type FirmAuditEvent } from './audit.service';

/**
 * REST surface for the firm-scoped audit log (EP5 Wave 2 W2-E).
 *
 * Firm-authenticated surface (behind FirmGuard):
 *   GET /firms/:id/audit         — paginated list (Wave 2).
 *   GET /firms/:id/audit/verify  — ClearTax §5.7 tamper-evident chain walk.
 *                                   The caller's active firm must equal :id,
 *                                   so this is the firm's own audit-of-audit.
 *
 * ClearTax partner surface (behind ClearTaxPartnerGuard):
 *   GET /partners/cleartax/firms/:firmId/audit — any firm, any tenant.
 *     Guarded by the §5.7 partner access control plane: mutual-TLS client
 *     cert, source-IP allowlist, and `clearance-partner` JWT role, all
 *     enforced by ClearTaxPartnerGuard. See
 *     docs/runbooks/cleartax-partner-access.md for operations.
 */
@Controller()
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get('firms/:id/audit')
  @UseGuards(FirmGuard)
  list(
    @Req() req: FirmAuthedRequest,
    @Param('id', new ParseUUIDPipe()) _id: string,
    @Query('limit') limitRaw?: string,
    @Query('eventType') eventType?: string,
    @Query('since') sinceRaw?: string,
  ): Promise<FirmAuditEvent[]> {
    // FirmGuard already asserted the active firm matches :id; we pass
    // req.firmId through so the service never sees an un-authorized id.
    void _id;
    const limit = limitRaw ? Math.max(1, Math.min(500, Number.parseInt(limitRaw, 10) || 50)) : 50;
    const since = sinceRaw ? new Date(sinceRaw) : undefined;
    return this.audit.list(req.firmId!, {
      limit,
      eventType,
      since: since && !Number.isNaN(since.getTime()) ? since : undefined,
    });
  }

  /**
   * ClearTax §5.7 tamper-evident audit-trail verification.
   *
   * Walks the per-(firm, tenant) hash chain for the active firm and
   * returns either `{ ok: true, totalEvents: N }` or `{ ok: false,
   * firstTamperAt, expected, actual, reason }`. The optional `tenantId`
   * query param narrows the walk to a single client-tenant's chain so an
   * inspector asking about one tenant does not need to see any other
   * tenant's data.
   */
  @Get('firms/:id/audit/verify')
  @UseGuards(FirmGuard)
  verify(
    @Req() req: FirmAuthedRequest,
    @Param('id', new ParseUUIDPipe()) _id: string,
    @Query('tenantId') tenantId?: string,
  ): Promise<AuditChainVerification> {
    void _id;
    // Empty string from a raw ?tenantId= with no value means "firm-level
    // chain only" (tenant_id IS NULL). Undefined means "whole firm".
    const scope = tenantId === undefined ? undefined : tenantId === '' ? null : tenantId;
    return this.audit.verifyChain(req.firmId!, scope);
  }

  /**
   * ClearTax partner read scope.
   *
   * ClearTax (our §5.7 declared PEPPOL access-point) reads any firm's
   * audit trail on-demand during OTA inspections. The ClearTaxPartnerGuard
   * enforces three independent checks before this handler runs:
   *   1. Caller presents a client cert issued by the ClearTax ops CA,
   *      verified by the ALB mutual-TLS listener and re-parsed here.
   *   2. Caller's source IP is on the partner allowlist.
   *   3. Caller's JWT carries `custom:role` (or `role`) = `clearance-partner`.
   *
   * The optional `tenantId` scopes the read to one client-tenant so an
   * inspection of a single tenant does not expose the whole firm. The
   * underlying `AuditService.list` already runs inside `withFirm(firmId,
   * …)` so RLS is in effect for the read; no new service method is needed.
   *
   * See docs/runbooks/cleartax-partner-access.md for the operations
   * manual (cert rotation, allowlist drift, 403-spike playbook).
   */
  @Get('partners/cleartax/firms/:firmId/audit')
  @UseGuards(ClearTaxPartnerGuard)
  cleartaxAudit(
    @Param('firmId', new ParseUUIDPipe()) firmId: string,
    @Query('tenantId') tenantId?: string,
    @Query('limit') limitRaw?: string,
    @Query('since') sinceRaw?: string,
  ): Promise<FirmAuditEvent[]> {
    const limit = limitRaw ? Math.max(1, Math.min(500, Number.parseInt(limitRaw, 10) || 50)) : 50;
    const since = sinceRaw ? new Date(sinceRaw) : undefined;
    return this.audit.list(firmId, {
      limit,
      since: since && !Number.isNaN(since.getTime()) ? since : undefined,
      // A raw `?tenantId=` with no value is treated the same as absent so
      // the whole firm is returned; a non-empty value scopes to that tenant.
      tenantId: tenantId && tenantId.length > 0 ? tenantId : undefined,
    });
  }
}
