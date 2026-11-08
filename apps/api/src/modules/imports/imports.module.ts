import { Module } from '@nestjs/common';
import { InvoicesModule } from '../invoices/invoices.module';
import { ImportsController } from './imports.controller';
import { ImportsService } from './imports.service';
import { FirmImportsController } from './firm-imports.controller';
import { FirmImportsService } from './firm-imports.service';
import { ColumnMappingService } from './column-mapping.service';

@Module({
  imports: [InvoicesModule],
  controllers: [ImportsController, FirmImportsController],
  providers: [ImportsService, FirmImportsService, ColumnMappingService],
  exports: [ImportsService, FirmImportsService, ColumnMappingService],
})
export class ImportsModule {}
