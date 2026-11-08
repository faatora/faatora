import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Logger,
  Param,
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { TenantGuard, type AuthContext } from '../../auth/tenant.guard';
import { CurrentUser } from '../../auth/current-user.decorator';
import { ClearanceGatewayService } from './clearance-gateway.service';
import type { TransmissionCallback } from './transmission-provider.port';

/**
 * HTTP surface for the clearance pipeline. Everything is tenant-scoped via
 * TenantGuard; the /drain endpoint is a dev convenience for Wave 3 — A17's
 * admin-role check will gate it later. The scheduler fires every 10s in
 * normal operation.
 */
@Controller('clearance')
export class ClearanceController {
  private readonly log = new Logger(ClearanceController.name);

  constructor(private readonly gateway: ClearanceGatewayService) {}

  /**
   * Submit a SIGNED invoice: writes the outbox row, flips invoice state to
   * SUBMITTED, journals the transition — all in one tx. Idempotent on the
   * invoice document UUID (calling it twice returns the same outboxId).
   */
  @Post('invoices/:id/submit')
  @UseGuards(TenantGuard)
  async submit(@CurrentUser() u: AuthContext, @Param('id') id: string) {
    const { outboxId, reused } = await this.gateway.enqueue(u.tenantId, id);
    return { outboxId, status: 'queued', reused };
  }

  @Get('invoices/:id/events')
  @UseGuards(TenantGuard)
  events(@CurrentUser() u: AuthContext, @Param('id') id: string) {
    return this.gateway.listEvents(u.tenantId, id);
  }

  @Get('invoices/:id/status')
  @UseGuards(TenantGuard)
  status(@CurrentUser() u: AuthContext, @Param('id') id: string) {
    return this.gateway.status(u.tenantId, id);
  }

  @Post('invoices/:id/retry')
  @UseGuards(TenantGuard)
  async retry(@CurrentUser() u: AuthContext, @Param('id') id: string) {
    const { outboxId } = await this.gateway.retry(u.tenantId, id);
    return { outboxId, status: 'queued' };
  }

  @Post('drain')
  @UseGuards(TenantGuard)
  async drain() {
    return this.gateway.drainOnce(50);
  }

  /**
   * Inbound ASP webhook (SEC-003).
   *
   * NOT behind TenantGuard — the ASP is not a tenant user and does not have
   * a Cognito token. Authentication is HMAC-SHA256 over the raw request body
   * with `ASP_WEBHOOK_SECRET`, delivered in the `x-asp-signature` header
   * (hex-encoded). The target tenant is passed in the `x-tenant-id` header
   * (the ASP learned the tenant at submission time).
   *
   * In production, both the secret and the signature are required; a missing
   * secret returns 503 (misconfigured), a bad signature returns 401. In
   * non-production the secret may be unset: the handler accepts the payload
   * and logs a warning so stub-ASP integration tests still work.
   */
  @Post('callback')
  @HttpCode(200)
  async callback(
    @Headers('x-asp-signature') signatureHeader: string | undefined,
    @Headers('x-tenant-id') tenantHeader: string | undefined,
    @Body() body: TransmissionCallback,
  ) {
    const nodeEnv = process.env.NODE_ENV ?? 'development';
    const secret = process.env.ASP_WEBHOOK_SECRET;

    if (!tenantHeader || typeof tenantHeader !== 'string') {
      throw new BadRequestException('x-tenant-id header is required');
    }

    if (nodeEnv === 'production' && !secret) {
      throw new ServiceUnavailableException('ASP webhook secret not configured');
    }

    if (secret) {
      if (!signatureHeader || typeof signatureHeader !== 'string') {
        throw new UnauthorizedException('x-asp-signature header is required');
      }
      // Canonicalize the body to the bytes we HMAC over. We serialise once
      // and compare the expected digest against the client-supplied one in
      // constant time to resist timing attacks.
      const rawBody = Buffer.from(JSON.stringify(body ?? {}), 'utf8');
      const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
      const provided = signatureHeader.trim().toLowerCase();
      let ok = false;
      try {
        const a = Buffer.from(expected, 'hex');
        const b = Buffer.from(provided, 'hex');
        ok = a.length === b.length && timingSafeEqual(a, b);
      } catch {
        ok = false;
      }
      if (!ok) {
        throw new UnauthorizedException('ASP signature mismatch');
      }
    } else {
      // Non-production and no secret configured. This path keeps stub-ASP
      // integration tests simple; it is unreachable in prod because of the
      // 503 above.
      this.log.warn('DEV mode: HMAC skipped (ASP_WEBHOOK_SECRET unset)');
    }

    await this.gateway.handleCallback(tenantHeader, body);
    return { ok: true };
  }
}
