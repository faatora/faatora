import {
  Controller,
  Get,
  NotImplementedException,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { FirmGuard, type FirmAuthedRequest } from '../../auth/firm.guard';
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
 * ClearTax partner surface (scaffold only — see cleartaxAudit):
 *   GET /partners/cleartax/firms/:firmId/audit — any firm, any tenant.
 *     SCAFFOLDING: real auth lives in a future `clearance-partner` role
 *     plus a mutual-TLS access-point (see docs/research/cleartax-partner.md).
 *     Until that lands, the endpoint throws NotImplementedException so a
 *     mis-configured deploy cannot accidentally expose an unauthenticated
 *     cross-firm read.
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
   * ClearTax partner read scope — SCAFFOLD.
   *
   * ClearTax (our §5.7 declared PEPPOL access-point) will read any firm's
   * audit trail on-demand during OTA inspections. The eventual guard
   * check is:
   *   1. Caller presents a client cert issued from the ClearTax ops CA.
   *   2. Caller's JWT carries `role: 'clearance-partner'`.
   *   3. Caller's source IP is on the partner allowlist (prod only).
   *
   * All three are enforced in a future `ClearTaxPartnerGuard`; this
   * handler is scaffolding so routes and OpenAPI docs line up with the
   * partner-pack contract today, without opening an unauthenticated read
   * before the guard ships. See docs/research/cleartax-partner.md for the
   * full spec and tracking issue #ct-§5.7.
   */
  @Get('partners/cleartax/firms/:firmId/audit')
  cleartaxAudit(
    @Param('firmId', new ParseUUIDPipe()) firmId: string,
    @Query('tenantId') tenantId?: string,
  ): Promise<FirmAuditEvent[]> {
    void firmId;
    void tenantId;
    throw new NotImplementedException(
      'ClearTax partner audit-read is gated on ClearTaxPartnerGuard (clearance-partner role + mTLS); see docs/research/cleartax-partner.md.',
    );
  }
}
