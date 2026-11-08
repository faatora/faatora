import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { TenantGuard, type AuthContext } from '../../auth/tenant.guard';
import { CurrentUser } from '../../auth/current-user.decorator';
import { PaymentsService } from './payments.service';
import { CreatePaymentDto } from './dto/create-payment.dto';

@Controller('payments')
@UseGuards(TenantGuard)
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}
  @Get() list(@CurrentUser() u: AuthContext) {
    return this.payments.list(u.tenantId);
  }
  @Post() create(@CurrentUser() u: AuthContext, @Body() dto: CreatePaymentDto) {
    return this.payments.create(u.tenantId, dto);
  }
  @Get(':id') get(@CurrentUser() u: AuthContext, @Param('id') id: string) {
    return this.payments.get(u.tenantId, id);
  }
}
