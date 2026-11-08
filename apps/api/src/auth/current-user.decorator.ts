import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AuthContext, AuthedRequest } from './tenant.guard';
export const CurrentUser = createParamDecorator(
  (_d: unknown, ctx: ExecutionContext): AuthContext => {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    return { userId: req.userId!, tenantId: req.tenantId!, role: req.role!, email: req.email! };
  },
);
