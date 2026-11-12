import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { verifyPagerDutySignature } from './pagerduty-signature';

/**
 * POST /api/webhooks/pagerduty — inbound PagerDuty V3 webhook sink.
 *
 * Delivers incident lifecycle events (`incident.triggered`,
 * `incident.acknowledged`, `incident.resolved`, …) to Faatora. For
 * now this is log-only; follow-ups will:
 *   TODO: write to a public status page row
 *   TODO: notify affected firms (per-tenant status board)
 *   TODO: emit a metric `faatora_pd_events_total`
 *
 * Security:
 *   - `rawBody: true` on NestFactory.create (main.ts) preserves the
 *     unparsed body as `req.rawBody` so HMAC verification signs the
 *     exact bytes PagerDuty signed.
 *   - A missing OR wrong `X-PagerDuty-Signature` returns 401. A
 *     missing `PAGERDUTY_WEBHOOK_SECRET` server-side returns 503
 *     (deploy misconfiguration — do not silently accept unverified
 *     payloads in production).
 */
interface RawRequest {
  rawBody?: Buffer;
}

interface PagerDutyWebhookEvent {
  id?: string;
  event_type?: string;
  resource_type?: string;
  occurred_at?: string;
  data?: {
    id?: string;
    type?: string;
    status?: string;
    summary?: string;
  };
}

interface PagerDutyWebhookPayload {
  event?: PagerDutyWebhookEvent;
}

@Controller('webhooks/pagerduty')
export class PagerDutyController {
  private readonly log = new Logger(PagerDutyController.name);

  @Post()
  @HttpCode(200)
  async handle(
    @Req() req: RawRequest,
    @Headers('x-pagerduty-signature') signature: string | undefined,
  ): Promise<{ received: true }> {
    const raw = req.rawBody;
    if (!raw || !Buffer.isBuffer(raw)) {
      throw new BadRequestException('raw body missing; rawBody must be enabled on the app');
    }

    const secret = process.env.PAGERDUTY_WEBHOOK_SECRET;
    if (!secret) {
      // 503 rather than 200: a deploy that forgets to inject the
      // secret should be loud. PagerDuty will retry with backoff and
      // ops will see the misconfiguration.
      this.log.error('PAGERDUTY_WEBHOOK_SECRET unset; refusing to accept unverified webhook');
      throw new ServiceUnavailableException('pagerduty webhook not configured');
    }

    if (!verifyPagerDutySignature(raw, signature, secret)) {
      throw new UnauthorizedException('invalid signature');
    }

    let payload: PagerDutyWebhookPayload;
    try {
      payload = JSON.parse(raw.toString('utf8')) as PagerDutyWebhookPayload;
    } catch {
      throw new BadRequestException('invalid json body');
    }

    const event = payload.event;
    this.log.log(
      {
        eventType: event?.event_type ?? 'unknown',
        resourceType: event?.resource_type ?? null,
        incidentId: event?.data?.id ?? null,
        incidentStatus: event?.data?.status ?? null,
        occurredAt: event?.occurred_at ?? null,
        pdEventId: event?.id ?? null,
      },
      'pagerduty webhook received',
    );

    return { received: true };
  }
}
