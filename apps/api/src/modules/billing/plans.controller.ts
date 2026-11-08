import { Controller, Get } from '@nestjs/common';
import { PlansService } from './plans.service';

@Controller('billing/plans')
export class PlansController {
  constructor(private readonly plans: PlansService) {}

  @Get()
  list() {
    return this.plans.list();
  }
}
