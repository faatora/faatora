import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { BillingSignatureError } from './billing.port';
import { FirmBillingService } from './billing.service';
import { WebhookEventsService } from './webhook-events.service';

/**
 * Minimal shape of an Express request that may carry a raw body.
 * We avoid importing from 'express' directly to keep @types/express
 * out of this module's dependency surface. `@nestjs/common` exposes
 * `RawBodyRequest<T>` but still requires an Express/Fastify Request
 * type param. A bare interface does the job here.
 */
interface RawRequest {
  rawBody?: Buffer;
}

/**
 * POST /api/billing/webhook. The firm-console subscription webhook sink.
 *
 * Signature verification runs BEFORE anything else. A missing or wrong
 * signature returns 400 (never 2xx). After verification the event is
 * written to `billing_webhook_events`; a conflict on
 * (provider, provider_event_id) means it is a replay and the handler
 * short-circuits. First-sight events run through FirmBillingService.handle
 * and then we stamp `processed_at`.
 *
 * Raw-body preservation: enabled globally in main.ts via
 * `NestFactory.create(app, { rawBody: true })`. The @RawBody-equivalent
 * `req.rawBody` is a Buffer that matches what Stripe signed.
 *
 * Signature source varies by provider:
 *   - Stripe: `stripe-signature` HEADER, computed over raw body.
 *   - Paymob: `hmac` QUERY PARAMETER, computed over 20 specific parsed
 *     fields (NOT raw body). See
 *     docs/research/paymob-uat-integration-plan.md section 6.2.
 * This controller accepts either and hands whichever is present to the
 * adapter's verifyWebhook. The adapter knows how to interpret.
 */
@Controller('billing/webhook')
export class BillingWebhookController {
  private readonly log = new Logger(BillingWebhookController.name);

  constructor(
    private readonly billing: FirmBillingService,
    private readonly events: WebhookEventsService,
  ) {}

  @Post()
  @HttpCode(200)
  async handle(
    @Req() req: RawRequest,
    @Headers('stripe-signature') stripeSig: string | undefined,
    @Query('hmac') paymobHmac: string | undefined,
  ): Promise<{ received: true; replay?: true }> {
    const raw = req.rawBody;
    if (!raw || !Buffer.isBuffer(raw)) {
      // No raw body means the top-level app was not booted with
      // rawBody: true. This is an infra bug, not a user error, but
      // we 400 rather than silently accept an unverifiable payload.
      throw new BadRequestException('raw body missing; rawBody must be enabled on the app');
    }
    // Pick whichever signature source is present. Stripe takes
    // precedence on the (rare) case both are supplied: the current
    // production deployment is Stripe, and Paymob only sends the
    // query param. The adapter's verifyWebhook enforces the right
    // shape for its own provider; a Stripe adapter given a Paymob
    // query string throws BillingSignatureError, which we already
    // translate to 400 below.
    const signature = stripeSig ?? paymobHmac;
    if (!signature || typeof signature !== 'string') {
      throw new BadRequestException(
        'missing signature; expected `stripe-signature` header or `?hmac=` query',
      );
    }

    let event;
    try {
      event = this.billing.verifyWebhook(raw, signature);
    } catch (err) {
      if (err instanceof BillingSignatureError) {
        throw new BadRequestException(`invalid signature: ${err.message}`);
      }
      throw err;
    }

    const stored = await this.events.record(event);
    if (!stored.firstSeen) {
      this.log.debug(
        { providerEventId: event.providerEventId, type: event.type },
        'webhook replay; short-circuiting',
      );
      return { received: true, replay: true };
    }

    try {
      await this.billing.handle(event);
      await this.events.markProcessed(stored.id);
    } catch (err) {
      // Deliberately do NOT markProcessed on failure; Stripe will
      // retry and the next attempt will re-run the handler.
      this.log.error(
        { err, providerEventId: event.providerEventId, type: event.type },
        'webhook handler failed; leaving processed_at NULL for retry',
      );
      // Return 500 so Stripe retries. Nest's default exception filter
      // handles this; rethrow preserves the stack.
      throw err;
    }

    return { received: true };
  }
}
