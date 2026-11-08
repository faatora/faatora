import {
  BadRequestException,
  Controller,
  Get,
  Header,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { Readable } from 'node:stream';
import { TenantGuard, type AuthContext } from '../../auth/tenant.guard';
import { CurrentUser } from '../../auth/current-user.decorator';
import { ArchiveService } from './archive.service';

/**
 * Archive HTTP surface.
 *
 * POST /archive/invoices/:id          — archive a CLEARED invoice.
 * GET  /archive/invoices/:id          — return the archive_records row.
 * GET  /archive/invoices/:id/content  — stream the archived XML.
 * GET  /archive/verify-chain          — recompute the chain and report ok/break.
 * GET  /archive/export?from=&to=      — list records for auditor pickup.
 *
 * Wave 3 manual trigger: POST /archive/invoices/:id is called by the UI
 * (or ops tooling). A14's clearance gateway could auto-trigger this once
 * invoices land in CLEARED — ArchiveModule exports ArchiveService for that.
 */
@Controller('archive')
@UseGuards(TenantGuard)
export class ArchiveController {
  constructor(private readonly archive: ArchiveService) {}

  @Post('invoices/:id')
  archiveInvoice(@CurrentUser() u: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.archive.archiveInvoice(u.tenantId, id);
  }

  @Get('invoices/:id')
  async getRecord(@CurrentUser() u: AuthContext, @Param('id', new ParseUUIDPipe()) id: string) {
    const row = await this.archive.getRecord(u.tenantId, id);
    if (!row) throw new NotFoundException('Archive record not found');
    return row;
  }

  @Get('invoices/:id/content')
  @Header('Content-Type', 'application/xml')
  async getContent(
    @CurrentUser() u: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<StreamableFile> {
    const content = await this.archive.getContent(u.tenantId, id);
    if (!content) throw new NotFoundException('Archive content not found');
    return new StreamableFile(Readable.from(content));
  }

  @Get('verify-chain')
  verifyChain(@CurrentUser() u: AuthContext) {
    return this.archive.verifyChain(u.tenantId);
  }

  @Get('export')
  async export(
    @CurrentUser() u: AuthContext,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    if (!from || !to) throw new BadRequestException('`from` and `to` query params are required');
    const fromDate = new Date(from);
    const toDate = new Date(to);
    if (isNaN(fromDate.getTime())) throw new BadRequestException('`from` is not a valid date');
    if (isNaN(toDate.getTime())) throw new BadRequestException('`to` is not a valid date');
    return this.archive.exportForAuditor(u.tenantId, fromDate, toDate);
  }
}
