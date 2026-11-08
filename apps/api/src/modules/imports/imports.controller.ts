import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import { TenantGuard, type AuthContext } from '../../auth/tenant.guard';
import { CurrentUser } from '../../auth/current-user.decorator';
import { ImportsService } from './imports.service';
import { Base64ImportDto } from './dto/base64-import.dto';

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

@Controller('imports')
@UseGuards(TenantGuard)
export class ImportsController {
  constructor(private readonly imports: ImportsService) {}

  @Post('csv')
  async importCsv(
    @CurrentUser() u: AuthContext,
    @Req() req: IncomingMessage,
    @Query('filename') filename?: string,
    @Headers('content-type') contentType?: string,
  ) {
    if (contentType && !/text\/csv|text\/plain|application\/octet-stream/i.test(contentType)) {
      throw new BadRequestException('Content-Type must be text/csv');
    }
    const buffer = await readRawBody(req);
    if (buffer.length === 0) throw new BadRequestException('Empty CSV body');
    return this.imports.startImport(u.tenantId, u.userId, 'csv', filename, buffer);
  }

  @Post('excel')
  async importExcel(@CurrentUser() u: AuthContext, @Body() dto: Base64ImportDto) {
    if (!dto?.base64) throw new BadRequestException('base64 is required');
    const buffer = Buffer.from(dto.base64, 'base64');
    if (buffer.length === 0) throw new BadRequestException('Empty Excel body');
    return this.imports.startImport(u.tenantId, u.userId, 'excel', dto.filename, buffer);
  }

  @Post('tally')
  async importTally(
    @CurrentUser() u: AuthContext,
    @Req() req: IncomingMessage,
    @Query('filename') filename?: string,
    @Headers('content-type') contentType?: string,
  ) {
    if (
      contentType &&
      !/text\/xml|application\/xml|text\/plain|application\/octet-stream/i.test(contentType)
    ) {
      throw new BadRequestException('Content-Type must be text/xml or application/xml');
    }
    const buffer = await readRawBody(req);
    if (buffer.length === 0) throw new BadRequestException('Empty XML body');
    return this.imports.startImport(u.tenantId, u.userId, 'tally_xml', filename, buffer);
  }

  @Get()
  list(@CurrentUser() u: AuthContext) {
    return this.imports.listJobs(u.tenantId);
  }

  @Get(':id')
  get(@CurrentUser() u: AuthContext, @Param('id') id: string) {
    return this.imports.getJobWithErrors(u.tenantId, id);
  }
}
