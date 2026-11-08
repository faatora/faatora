import { Body, Controller, Post, Req } from '@nestjs/common';
import { LeadsService } from './leads.service';
import { CreateLeadDto } from './dto/create-lead.dto';
interface RequestWithIp {
  ip?: string;
}
@Controller('leads')
export class LeadsController {
  constructor(private readonly leads: LeadsService) {}
  @Post() create(@Body() dto: CreateLeadDto, @Req() req: RequestWithIp) {
    return this.leads.create(dto, req.ip);
  }
}
