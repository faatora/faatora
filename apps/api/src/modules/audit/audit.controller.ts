import { Controller, Get, Param, ParseUUIDPipe, Query, Req, UseGuards } from '@nestjs/common';
import { FirmGuard, type FirmAuthedRequest } from '../../auth/firm.guard';
import { AuditService, type FirmAuditEvent } from './audit.service';

/**
 * REST surface for the firm-scoped audit log (EP5 Wave 2 W2-E).
 *
 * Only the paginated list is exposed in Wave 2. The `GET /firms/:id/audit`
 * route sits behind FirmGuard so the only firm whose events the caller
 * can read is the one they have an active membership for. The viewer UI
 * is deferred to Wave 3; this endpoint is what the UI will call.
 *
 * Per-tenant export (CSV / JSON) is on AuditService.exportForTenant and
 * will be surfaced over HTTP in the Wave 3 export module.
 */
@Controller('firms')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get(':id/audit')
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
}
