/**
 * W2-D — firm-scoped import endpoints.
 *
 *   POST /firms/:id/imports/preview — multipart-or-raw upload, returns
 *   {rows, errors, summary, previewToken} without touching the DB
 *   invoices table.
 *
 *   POST /firms/:id/imports/commit — takes the preview token and
 *   optionally an edited column mapping, writes DRAFT invoices under
 *   withFirmTenant, inserts the import_batches row, returns
 *   {batchId, rowCount*}.
 *
 *   GET /firms/:id/imports/mapping/:sourceFormat — the mapping that
 *   would be applied (firm override if set, else default).
 *
 *   PUT /firms/:id/imports/mapping/:sourceFormat — save a firm override.
 *
 * Multipart is not strictly needed: the preview endpoint accepts the
 * file as raw body and the tenant id / source format as query params,
 * so the wizard can send a straight fetch(upload, body: File). This
 * avoids pulling in a multipart parser dependency for a single route.
 */

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import { FirmGuard, type FirmAuthedRequest } from '../../auth/firm.guard';
import {
  ColumnMappingService,
  type ColumnMapping,
} from './column-mapping.service';
import {
  FirmImportsService,
  type CommitResult,
  type PreviewResult,
} from './firm-imports.service';
import {
  IMPORT_SOURCE_FORMATS,
  isImportSourceFormat,
  type ImportSourceFormat,
} from './parsers/parsed-import-row';

async function readRawBody(req: IncomingMessage, maxBytes = 25 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buf.length;
    if (total > maxBytes) throw new BadRequestException('Payload too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

interface CommitBody {
  previewToken?: string;
  mapping?: ColumnMapping;
  saveMapping?: boolean;
}

interface SaveMappingBody {
  mapping: ColumnMapping;
}

@Controller('firms/:id/imports')
@UseGuards(FirmGuard)
export class FirmImportsController {
  constructor(
    private readonly imports: FirmImportsService,
    private readonly mappings: ColumnMappingService,
  ) {}

  @Get('source-formats')
  listFormats(): { formats: ImportSourceFormat[] } {
    return { formats: IMPORT_SOURCE_FORMATS };
  }

  @Get('mapping/:sourceFormat')
  async getMapping(
    @Req() req: FirmAuthedRequest,
    @Param('sourceFormat') sourceFormat: string,
  ): Promise<{ sourceFormat: ImportSourceFormat; mapping: ColumnMapping; isDefault: boolean }> {
    if (!isImportSourceFormat(sourceFormat)) {
      throw new BadRequestException('Unsupported source format');
    }
    const mapping = await this.mappings.getForFirm(req.firmId!, sourceFormat);
    const defaultMapping = this.mappings.getDefault(sourceFormat);
    const isDefault = JSON.stringify(mapping) === JSON.stringify(defaultMapping);
    return { sourceFormat, mapping, isDefault };
  }

  @Put('mapping/:sourceFormat')
  async saveMapping(
    @Req() req: FirmAuthedRequest,
    @Param('sourceFormat') sourceFormat: string,
    @Body() body: SaveMappingBody,
  ): Promise<{ sourceFormat: ImportSourceFormat; mapping: ColumnMapping }> {
    if (!isImportSourceFormat(sourceFormat)) {
      throw new BadRequestException('Unsupported source format');
    }
    if (!body?.mapping || typeof body.mapping !== 'object') {
      throw new BadRequestException('mapping body is required');
    }
    const mapping = await this.mappings.saveForFirm(req.firmId!, sourceFormat, body.mapping);
    return { sourceFormat, mapping };
  }

  @Post('preview')
  async preview(
    @Req() req: FirmAuthedRequest & IncomingMessage,
    @Param('id', new ParseUUIDPipe()) _firmId: string,
    @Query('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Query('sourceFormat') sourceFormat: string,
    @Query('filename') filename: string | undefined,
    @Headers('content-type') _ct?: string,
  ): Promise<PreviewResult> {
    void _firmId;
    if (!isImportSourceFormat(sourceFormat)) {
      throw new BadRequestException('Unsupported source format');
    }
    const file = await readRawBody(req);
    return this.imports.preview(req.firmId!, {
      tenantId,
      sourceFormat,
      filename,
      file,
    });
  }

  @Post('commit')
  async commit(
    @Req() req: FirmAuthedRequest,
    @Param('id', new ParseUUIDPipe()) _firmId: string,
    @Body() body: CommitBody,
  ): Promise<CommitResult> {
    void _firmId;
    if (!body?.previewToken || typeof body.previewToken !== 'string') {
      throw new BadRequestException('previewToken is required');
    }
    return this.imports.commit(
      req.firmId!,
      req.userId!,
      body.previewToken,
      body.mapping,
      body.saveMapping,
    );
  }
}
