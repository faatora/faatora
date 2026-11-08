import { Module } from '@nestjs/common';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';
import { PartiesController } from './parties.controller';
import { PartiesService } from './parties.service';
import { COMPLIANCE_VALIDATOR } from './compliance.port';
import { PipelineComplianceValidator } from './compliance.pipeline';
@Module({
  controllers: [InvoicesController, PartiesController],
  providers: [
    InvoicesService,
    PartiesService,
    // A13 swap: the Noop validator is retained in `compliance.port` for
    // tests that explicitly want it, but production DI now binds the
    // full canonical → VAT math → UBL → Schematron-lite pipeline.
    { provide: COMPLIANCE_VALIDATOR, useClass: PipelineComplianceValidator },
  ],
  exports: [InvoicesService, PartiesService, COMPLIANCE_VALIDATOR],
})
export class InvoicesModule {}
