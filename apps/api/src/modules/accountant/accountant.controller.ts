import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AccountantAuthGuard, type AccountantAuthedRequest } from './accountant-auth.guard';
import { AccountantService } from './accountant.service';
import { CreateFirmDto } from './dto/create-firm.dto';

@Controller('accountant')
@UseGuards(AccountantAuthGuard)
export class AccountantController {
  constructor(private readonly svc: AccountantService) {}

  @Get('me/firm')
  getFirm(@Req() req: AccountantAuthedRequest) {
    return this.svc.getFirmForUser(req.userId!);
  }

  @Post('me/firm')
  createFirm(@Req() req: AccountantAuthedRequest, @Body() dto: CreateFirmDto) {
    return this.svc.createFirm(req.userId!, dto);
  }

  @Get('me/tenants')
  listTenants(@Req() req: AccountantAuthedRequest) {
    return this.svc.listMyTenants(req.userId!);
  }

  @Post('me/tenants/:tenantId/link')
  link(
    @Req() req: AccountantAuthedRequest,
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body() body: { referred?: boolean } = {},
  ) {
    return this.svc.linkClient(req.userId!, tenantId, { referred: body?.referred });
  }

  @Delete('me/tenants/:tenantId/link')
  unlink(
    @Req() req: AccountantAuthedRequest,
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
  ) {
    return this.svc.unlinkClient(req.userId!, tenantId);
  }

  @Get('me/kpis')
  kpis(@Req() req: AccountantAuthedRequest) {
    return this.svc.consolidatedKpis(req.userId!);
  }

  @Get('me/commission')
  commission(
    @Req() req: AccountantAuthedRequest,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    if (!from || !to) {
      throw new BadRequestException('from and to query parameters are required');
    }
    return this.svc.calculateCommission(req.userId!, from, to);
  }
}
