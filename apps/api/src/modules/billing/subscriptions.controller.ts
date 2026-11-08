import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { IsString, Length } from 'class-validator';
import { TenantGuard, type AuthContext } from '../../auth/tenant.guard';
import { CurrentUser } from '../../auth/current-user.decorator';
import { SubscriptionsService } from './subscriptions.service';

export class SubscribeDto {
  @IsString()
  @Length(1, 64)
  planCode!: string;
}

@Controller('billing/subscription')
@UseGuards(TenantGuard)
export class SubscriptionsController {
  constructor(private readonly subs: SubscriptionsService) {}

  @Get()
  get(@CurrentUser() u: AuthContext) {
    return this.subs.getActive(u.tenantId);
  }

  @Post()
  subscribe(@CurrentUser() u: AuthContext, @Body() dto: SubscribeDto) {
    return this.subs.subscribe(u.tenantId, dto.planCode);
  }

  @Post('cancel')
  cancel(@CurrentUser() u: AuthContext) {
    return this.subs.cancel(u.tenantId);
  }
}
