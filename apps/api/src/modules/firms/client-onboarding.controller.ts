/**
 * EP5 Wave 2 (W2-C) -- client-onboarding and batch-operations endpoints.
 *
 * Separate controller so firms.controller.ts (Wave 1 bare CRUD) stays
 * compact. Everything here lives under the same /firms/:id base so
 * FirmGuard applies uniformly.
 */

import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { FirmGuard, type FirmAuthedRequest } from '../../auth/firm.guard';
import { FirmsService } from './firms.service';
import { BatchOperationsService } from './batch-operations.service';
import {
  CreateClientTenantSchema,
  CreateClientTenantsBatchSchema,
  VatReturnQuerySchema,
  type CreateClientTenantDto,
  type CreateClientTenantsBatchDto,
  type VatReturnQueryDto,
} from './dto/schemas';
import { ZodValidationPipe } from './dto/zod.pipe';

/**
 * Minimal Response shape used below. We stay off @types/express the same
 * way webhook.controller.ts does so this module's dependency surface
 * stays narrow.
 */
interface CsvResponse {
  setHeader(name: string, value: string): void;
  send(body: unknown): void;
}

@Controller('firms')
@UseGuards(FirmGuard)
export class ClientOnboardingController {
  constructor(
    private readonly firms: FirmsService,
    private readonly batch: BatchOperationsService,
  ) {}

  /**
   * POST /firms/:id/clients/onboard
   *
   * Superset of the Wave 1 POST /firms/:id/clients (which only linked
   * existing tenants). Creates the tenant row AND the link in one
   * transaction, optionally provisioning a tenant owner for the shop
   * owner's email.
   */
  @Post(':id/clients/onboard')
  onboardSingle(
    @Req() req: FirmAuthedRequest,
    @Param('id', new ParseUUIDPipe()) _firmId: string,
    @Body(new ZodValidationPipe(CreateClientTenantSchema)) dto: CreateClientTenantDto,
  ) {
    void _firmId;
    return this.firms.createClientTenant(req.firmId!, dto, req.userId);
  }

  /**
   * POST /firms/:id/clients/batch
   *
   * Up to 50 clients per call; see FirmsService.createClientTenantsBatch
   * for the per-row error structure.
   */
  @Post(':id/clients/batch')
  onboardBatch(
    @Req() req: FirmAuthedRequest,
    @Param('id', new ParseUUIDPipe()) _firmId: string,
    @Body(new ZodValidationPipe(CreateClientTenantsBatchSchema))
    dto: CreateClientTenantsBatchDto,
  ) {
    void _firmId;
    return this.firms.createClientTenantsBatch(req.firmId!, dto.clients, req.userId);
  }

  /**
   * POST /firms/:id/operations/validate-all
   *
   * Dry-run compliance preview over every DRAFT invoice in every active
   * client tenant. No state mutation.
   */
  @Post(':id/operations/validate-all')
  validateAll(@Req() req: FirmAuthedRequest, @Param('id', new ParseUUIDPipe()) _firmId: string) {
    void _firmId;
    return this.batch.validateAllPending(req.firmId!);
  }

  /**
   * GET /firms/:id/operations/vat-return.csv?periodStart=&periodEnd=
   *
   * Streams a CSV of aggregated VAT totals per client tenant.
   */
  @Get(':id/operations/vat-return.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async vatReturnCsv(
    @Req() req: FirmAuthedRequest,
    @Param('id', new ParseUUIDPipe()) _firmId: string,
    @Query(new ZodValidationPipe(VatReturnQuerySchema)) query: VatReturnQueryDto,
    @Res() res: CsvResponse,
  ) {
    void _firmId;
    const rows = await this.batch.exportVatReturnSummaries(
      req.firmId!,
      query.periodStart,
      query.periodEnd,
    );
    const csv = BatchOperationsService.renderVatReturnCsv(rows);
    const filename = `vat-return-${query.periodStart}-to-${query.periodEnd}.csv`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  }
}
