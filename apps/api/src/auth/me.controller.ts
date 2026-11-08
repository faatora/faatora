import { Controller, Get, UseGuards } from '@nestjs/common';
import { TenantGuard, type AuthContext } from './tenant.guard';
import { CurrentUser } from './current-user.decorator';
@Controller('me')
@UseGuards(TenantGuard)
export class MeController {
  @Get() me(@CurrentUser() u: AuthContext): AuthContext {
    return u;
  }
}
