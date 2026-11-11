import { Module } from '@nestjs/common';
import { FirmGuard } from '../../auth/firm.guard';
import { InvoicesModule } from '../invoices/invoices.module';
import { TaxDocumentsController } from './tax-documents.controller';
import { TaxDocumentsService } from './tax-documents.service';

/**
 * Credit note + debit note module.
 *
 * Imports InvoicesModule only for its `money.ts` totals helper; the
 * compliance pipeline is called directly here because the tax
 * document path builds its own canonical shape (with parties resolved
 * from the original invoice) — different from the invoice path which
 * carries the party ids through the compliance port's placeholder
 * shape.
 *
 * The FirmGuard is re-exported here so the controller can bind it
 * without the whole FirmsModule DI graph.
 */
@Module({
  imports: [InvoicesModule],
  controllers: [TaxDocumentsController],
  providers: [TaxDocumentsService, FirmGuard],
  exports: [TaxDocumentsService],
})
export class TaxDocumentsModule {}
