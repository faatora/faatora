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
import { PlatformStatusService } from './platform-status.service';
import { pagerDutyEventsTotal } from '../../common/observability/metrics';

/**
 * POST /api/webhooks/pagerduty — inbound PagerDuty V3 webhook sink.
 *
 * Delivers incident lifecycle events (`incident.triggered`,
 * `incident.acknowledged`, `incident.resolved`, …) to Faatora. For
 * each verified event we:
 *
 *   1. Bump `faatora_pd_events_total{event_type,resource_type}` so
 *      ops can alert on inbound incident volume.
 *   2. Hand the event to `PlatformStatusService`, which appends a
 *      row to `platform_status_events` (public status page) AND
 *      emits `platform.status.event` on EventEmitter2 for per-tenant
 *      status-board subscribers.
 *
 * Both steps are best-effort — we never 5xx back to PagerDuty for a
 * downstream failure. PagerDuty retries on 5xx with backoff, and a
 * persistent retry loop would stall the counter + bus emission
 * exactly when ops most need them.
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

  constructor(private readonly status: PlatformStatusService) {}

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

    // Bump the counter once per verified delivery. `unknown` is a
    // sentinel so a malformed payload still shows up on the dashboard
    // — "unknown spiked" is a signal worth investigating.
    pagerDutyEventsTotal.inc({
      event_type: event?.event_type ?? 'unknown',
      resource_type: event?.resource_type ?? 'unknown',
    });

    // record() swallows its own errors — the controller returns 200
    // either way so PagerDuty does not retry endlessly (see the
    // availability-vs-durability note on PlatformStatusService).
    await this.status.record({
      incidentId: event?.data?.id ?? 'unknown',
      eventType: event?.event_type ?? 'unknown',
      summary: event?.data?.summary,
      occurredAt: event?.occurred_at ? new Date(event.occurred_at) : new Date(),
      raw: event,
    });

    return { received: true };
  }
}
