/**
 * Unit tests for the PagerDuty wiring:
 *   - verifyPagerDutySignature (HMAC parsing + rotation support)
 *   - PagerDutyService.buildTriggerPayload (Events API v2 shape)
 *   - PagerDutyService.trigger wire format (fetch mocked)
 */
import { createHmac } from 'node:crypto';
import { verifyPagerDutySignature } from '../src/modules/alerts/pagerduty-signature';
import { PagerDutyService } from '../src/common/alerts/pagerduty.service';

describe('verifyPagerDutySignature', () => {
  const secret = 'shhh-no-peeking';
  const body = Buffer.from(JSON.stringify({ event: { event_type: 'incident.triggered' } }));
  const good = createHmac('sha256', secret).update(body).digest('hex');

  it('accepts a single valid v1 signature', () => {
    expect(verifyPagerDutySignature(body, `v1=${good}`, secret)).toBe(true);
  });

  it('accepts when the correct v1 signature is one of several (rotation)', () => {
    const header = `v1=${'0'.repeat(64)},v1=${good}`;
    expect(verifyPagerDutySignature(body, header, secret)).toBe(true);
  });

  it('rejects an empty or missing header', () => {
    expect(verifyPagerDutySignature(body, undefined, secret)).toBe(false);
    expect(verifyPagerDutySignature(body, '', secret)).toBe(false);
  });

  it('rejects a wrong secret', () => {
    expect(verifyPagerDutySignature(body, `v1=${good}`, 'different-secret')).toBe(false);
  });

  it('rejects a mangled body', () => {
    const tampered = Buffer.from(body.toString('utf8') + 'x');
    expect(verifyPagerDutySignature(tampered, `v1=${good}`, secret)).toBe(false);
  });

  it('ignores unknown version prefixes (future-proofing)', () => {
    const header = `v2=${good},v3=${good}`;
    expect(verifyPagerDutySignature(body, header, secret)).toBe(false);
  });

  it('is case-insensitive on the version marker', () => {
    expect(verifyPagerDutySignature(body, `V1=${good}`, secret)).toBe(true);
  });

  it('shrugs off malformed entries without throwing', () => {
    expect(() =>
      verifyPagerDutySignature(body, 'garbage,v1=,v1=notHex', secret),
    ).not.toThrow();
    expect(verifyPagerDutySignature(body, 'garbage', secret)).toBe(false);
  });

  it('rejects a hex of the wrong length (not a sha256)', () => {
    expect(verifyPagerDutySignature(body, `v1=${'a'.repeat(40)}`, secret)).toBe(false);
  });
});

describe('PagerDutyService.buildTriggerPayload', () => {
  const svc = new PagerDutyService();

  it('matches the Events API v2 trigger shape', () => {
    const payload = svc.buildTriggerPayload('ROUTE_KEY_12345', {
      summary: 'canary heartbeat lost',
      severity: 'critical',
      source: 'faatora-api-prod',
      component: 'canary',
      group: 'prod',
      class: 'exception',
      customDetails: { lastSeenSeconds: 362, runbook: 'docs/runbooks/dlq-filling.md' },
      dedupKey: 'canary::heartbeat',
    });

    expect(payload).toEqual({
      routing_key: 'ROUTE_KEY_12345',
      event_action: 'trigger',
      dedup_key: 'canary::heartbeat',
      payload: {
        summary: 'canary heartbeat lost',
        severity: 'critical',
        source: 'faatora-api-prod',
        component: 'canary',
        group: 'prod',
        class: 'exception',
        custom_details: {
          lastSeenSeconds: 362,
          runbook: 'docs/runbooks/dlq-filling.md',
        },
      },
    });
  });

  it('omits optional fields when not supplied', () => {
    const payload = svc.buildTriggerPayload('ROUTE_KEY', {
      summary: 's',
      severity: 'warning',
      source: 'src',
    });
    expect(payload).toEqual({
      routing_key: 'ROUTE_KEY',
      event_action: 'trigger',
      payload: {
        summary: 's',
        severity: 'warning',
        source: 'src',
      },
    });
    // specifically: no dedup_key, no component/group/class/custom_details
    expect(payload).not.toHaveProperty('dedup_key');
    const inner = (payload as { payload: Record<string, unknown> }).payload;
    expect(inner).not.toHaveProperty('component');
    expect(inner).not.toHaveProperty('group');
    expect(inner).not.toHaveProperty('class');
    expect(inner).not.toHaveProperty('custom_details');
  });
});

describe('PagerDutyService — trigger/acknowledge/resolve HTTP wiring', () => {
  const ORIGINAL_FETCH = globalThis.fetch;
  const ORIGINAL_ROUTING = process.env.PAGERDUTY_ROUTING_KEY;

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    if (ORIGINAL_ROUTING === undefined) {
      delete process.env.PAGERDUTY_ROUTING_KEY;
    } else {
      process.env.PAGERDUTY_ROUTING_KEY = ORIGINAL_ROUTING;
    }
  });

  it('is a no-op (returns null) when PAGERDUTY_ROUTING_KEY is unset', async () => {
    delete process.env.PAGERDUTY_ROUTING_KEY;
    const fetchSpy = jest.fn();
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const svc = new PagerDutyService();
    await expect(
      svc.trigger({ summary: 's', severity: 'info', source: 'test' }),
    ).resolves.toBeNull();
    await expect(svc.acknowledge('key')).resolves.toBe(false);
    await expect(svc.resolve('key')).resolves.toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POSTs to the Events API v2 enqueue endpoint with the right shape', async () => {
    process.env.PAGERDUTY_ROUTING_KEY = 'ROUTE_KEY_XYZ';
    const fetchSpy = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'success',
        message: 'Event processed',
        dedup_key: 'srv-generated-dedup',
      }),
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const svc = new PagerDutyService();
    const dedup = await svc.trigger({
      summary: 'canary missed',
      severity: 'error',
      source: 'canary',
    });

    expect(dedup).toBe('srv-generated-dedup');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = fetchSpy.mock.calls[0]!;
    expect(call[0]).toBe('https://events.pagerduty.com/v2/enqueue');
    const init = call[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['content-type']).toBe(
      'application/json',
    );
    const body = JSON.parse(String(init.body));
    expect(body.routing_key).toBe('ROUTE_KEY_XYZ');
    expect(body.event_action).toBe('trigger');
    expect(body.payload.summary).toBe('canary missed');
    expect(body.payload.severity).toBe('error');
  });

  it('acknowledge/resolve send event_action with the dedup_key', async () => {
    process.env.PAGERDUTY_ROUTING_KEY = 'ROUTE_KEY_XYZ';
    const fetchSpy = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'success',
        message: 'Event processed',
        dedup_key: 'k',
      }),
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const svc = new PagerDutyService();
    await svc.acknowledge('k');
    await svc.resolve('k');

    const bodies = fetchSpy.mock.calls.map((c) => JSON.parse(String((c[1] as RequestInit).body)));
    expect(bodies[0]).toMatchObject({
      routing_key: 'ROUTE_KEY_XYZ',
      event_action: 'acknowledge',
      dedup_key: 'k',
    });
    expect(bodies[1]).toMatchObject({
      routing_key: 'ROUTE_KEY_XYZ',
      event_action: 'resolve',
      dedup_key: 'k',
    });
  });

  it('returns null and does NOT throw on a non-2xx PagerDuty response', async () => {
    process.env.PAGERDUTY_ROUTING_KEY = 'ROUTE_KEY_XYZ';
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'bad routing key',
    }) as unknown as typeof globalThis.fetch;

    const svc = new PagerDutyService();
    await expect(
      svc.trigger({ summary: 's', severity: 'info', source: 'test' }),
    ).resolves.toBeNull();
  });

  it('returns null and does NOT throw on a network error', async () => {
    process.env.PAGERDUTY_ROUTING_KEY = 'ROUTE_KEY_XYZ';
    globalThis.fetch = jest.fn().mockRejectedValue(
      new Error('ENETUNREACH'),
    ) as unknown as typeof globalThis.fetch;

    const svc = new PagerDutyService();
    await expect(
      svc.trigger({ summary: 's', severity: 'info', source: 'test' }),
    ).resolves.toBeNull();
  });
});
