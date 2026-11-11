/**
 * HTTP endpoints for credit notes and debit notes.
 *
 * Routes are nested under /firms/:firmId/clients/:clientId so the firm
 * -console UI, which already knows the active firm and selected
 * client tenant, can hit these without round-tripping the x-tenant-id
 * header. Both resources share a service; the controller forwards the
 * document kind to it.
 *
 * Authn is FirmGuard: the caller must have a non-revoked firm
 * membership for firmId. The withFirmTenant wrapper inside the service
 * then enforces the active engagement with :clientId.
 */

import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { FirmGuard, type FirmAuthedRequest } from '../../auth/firm.guard';
import { CreateTaxDocumentDto } from './dto/create-tax-document.dto';
import { TaxDocumentsService } from './tax-documents.service';

@Controller('firms/:firmId/clients/:clientId')
@UseGuards(FirmGuard)
export class TaxDocumentsController {
  constructor(private readonly svc: TaxDocumentsService) {}

  @Post('credit-notes')
  createCreditNote(
    @Req() req: FirmAuthedRequest,
    @Param('firmId', new ParseUUIDPipe()) _firmId: string,
    @Param('clientId', new ParseUUIDPipe()) clientId: string,
    @Body() dto: CreateTaxDocumentDto,
  ) {
    // FirmGuard binds req.firmId to the token's active firm; the URL
    // firmId must agree. Any mismatch is a client bug or a token
    // misuse — fail fast.
    if (_firmId !== req.firmId) {
      throw new Error('Firm id in URL does not match active firm context');
    }
    return this.svc.create(req.firmId!, clientId, 'credit_note', req.userId!, dto);
  }

  @Post('debit-notes')
  createDebitNote(
    @Req() req: FirmAuthedRequest,
    @Param('firmId', new ParseUUIDPipe()) _firmId: string,
    @Param('clientId', new ParseUUIDPipe()) clientId: string,
    @Body() dto: CreateTaxDocumentDto,
  ) {
    if (_firmId !== req.firmId) {
      throw new Error('Firm id in URL does not match active firm context');
    }
    return this.svc.create(req.firmId!, clientId, 'debit_note', req.userId!, dto);
  }

  @Get('credit-notes')
  listCreditNotes(
    @Req() req: FirmAuthedRequest,
    @Param('firmId', new ParseUUIDPipe()) _firmId: string,
    @Param('clientId', new ParseUUIDPipe()) clientId: string,
  ) {
    void _firmId;
    return this.svc.list(req.firmId!, clientId, 'credit_note');
  }

  @Get('debit-notes')
  listDebitNotes(
    @Req() req: FirmAuthedRequest,
    @Param('firmId', new ParseUUIDPipe()) _firmId: string,
    @Param('clientId', new ParseUUIDPipe()) clientId: string,
  ) {
    void _firmId;
    return this.svc.list(req.firmId!, clientId, 'debit_note');
  }

  @Get('tax-documents/:id')
  get(
    @Req() req: FirmAuthedRequest,
    @Param('firmId', new ParseUUIDPipe()) _firmId: string,
    @Param('clientId', new ParseUUIDPipe()) clientId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    void _firmId;
    return this.svc.get(req.firmId!, clientId, id);
  }
}
