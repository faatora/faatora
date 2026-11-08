/**
 * Faatora observability — Prometheus metrics registry (EP1 §obs / A16).
 *
 * One in-process `prom-client` Registry is created on first import and
 * returned by {@link defaultRegistry}. All metric handles below are
 * registered against that singleton so a single `/metrics` scrape sees
 * everything.
 *
 * NAMING. Every metric is prefixed with `faatora_` and uses the Prometheus
 * convention of `_total` for counters and `_seconds` for latency
 * histograms. Labels are kept to the minimum cardinality necessary to
 * answer the 3-AM question — `tenant_id` is only on top-level counters
 * where the cost (one series per tenant) is cheap and the diagnostic
 * value (which customer is bleeding?) is high.
 *
 * HELPERS. `incCounter` / `observeHistogram` / `setGauge` provide a
 * loosely-typed façade so other modules can emit a metric by name
 * without taking a direct dependency on the concrete handle. The three
 * helpers throw if the metric name is unknown — a typo there is a bug,
 * not a runtime condition we want to swallow.
 */

import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * The one Registry every helper in this file writes to. Exported so a
 * controller can `.metrics()` it on demand.
 */
export const defaultRegistry: Registry = new Registry();

// Default process / event-loop / GC metrics — flipping on prom-client's
// recommended node_* set. Namespaced by prefix so they don't collide
// with the faatora_* families below.
collectDefaultMetrics({ register: defaultRegistry, prefix: 'faatora_node_' });

/** Latency buckets shared by request and clearance histograms. */
const LATENCY_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

// --- HTTP ------------------------------------------------------------------

export const httpRequestsTotal = new Counter({
  name: 'faatora_http_requests_total',
  help: 'Total HTTP requests served by the API, labelled by route/method/status/tenant.',
  labelNames: ['method', 'route', 'status_code', 'tenant_id'] as const,
  registers: [defaultRegistry],
});

export const httpRequestDurationSeconds = new Histogram({
  name: 'faatora_http_request_duration_seconds',
  help: 'HTTP request duration in seconds, labelled by route/method/status.',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: LATENCY_BUCKETS,
  registers: [defaultRegistry],
});

// --- Invoicing / clearance -------------------------------------------------

export const invoiceIssuedTotal = new Counter({
  name: 'faatora_invoice_issued_total',
  help: 'Invoices issued by the invoicing pipeline (post-signature).',
  labelNames: ['tenant_id', 'type'] as const,
  registers: [defaultRegistry],
});

export const clearanceSubmissionsTotal = new Counter({
  name: 'faatora_clearance_submissions_total',
  help: 'Clearance submission attempts to the ASP, by terminal result.',
  // result: cleared | rejected | accepted_pending | error
  labelNames: ['tenant_id', 'result'] as const,
  registers: [defaultRegistry],
});

export const clearanceLatencySeconds = new Histogram({
  name: 'faatora_clearance_latency_seconds',
  help: 'End-to-end clearance submission latency in seconds.',
  labelNames: ['result'] as const,
  buckets: LATENCY_BUCKETS,
  registers: [defaultRegistry],
});

export const clearanceRejectionReasonTotal = new Counter({
  name: 'faatora_clearance_rejection_reason_total',
  help: 'Clearance rejections grouped by ASP/OTA reason code.',
  labelNames: ['reason_code'] as const,
  registers: [defaultRegistry],
});

export const clearanceQueueDepth = new Gauge({
  name: 'faatora_clearance_queue_depth',
  help: 'Depth of the clearance_outbox grouped by status.',
  labelNames: ['status'] as const,
  registers: [defaultRegistry],
});

export const clearanceDlqSize = new Gauge({
  name: 'faatora_clearance_dlq_size',
  help: 'Current row count of the clearance_dlq table.',
  registers: [defaultRegistry],
});

export const canaryLastSuccessTimestamp = new Gauge({
  name: 'faatora_canary_last_success_timestamp',
  help: 'Unix seconds when the synthetic canary last reported success.',
  registers: [defaultRegistry],
});

export const signingTotal = new Counter({
  name: 'faatora_signing_total',
  help: 'Invoice signatures produced, by terminal result.',
  labelNames: ['tenant_id', 'result'] as const,
  registers: [defaultRegistry],
});

/* -------------------------------------------------------------------------- */
/* Dispatch table + helpers                                                   */
/*                                                                            */
/* We expose a tiny name-indexed façade so modules that don't want to pull in */
/* the Prometheus types can still emit through `incCounter`/… by name. The    */
/* façade is intentionally loosely typed: the label shape per metric is in    */
/* the registered handle above and prom-client validates it at observe time.  */
/* -------------------------------------------------------------------------- */

type CounterName =
  | 'faatora_http_requests_total'
  | 'faatora_invoice_issued_total'
  | 'faatora_clearance_submissions_total'
  | 'faatora_clearance_rejection_reason_total'
  | 'faatora_signing_total';

type HistogramName = 'faatora_http_request_duration_seconds' | 'faatora_clearance_latency_seconds';

type GaugeName =
  | 'faatora_clearance_queue_depth'
  | 'faatora_clearance_dlq_size'
  | 'faatora_canary_last_success_timestamp';

const counters: Record<CounterName, Counter<string>> = {
  faatora_http_requests_total: httpRequestsTotal,
  faatora_invoice_issued_total: invoiceIssuedTotal,
  faatora_clearance_submissions_total: clearanceSubmissionsTotal,
  faatora_clearance_rejection_reason_total: clearanceRejectionReasonTotal,
  faatora_signing_total: signingTotal,
};

const histograms: Record<HistogramName, Histogram<string>> = {
  faatora_http_request_duration_seconds: httpRequestDurationSeconds,
  faatora_clearance_latency_seconds: clearanceLatencySeconds,
};

const gauges: Record<GaugeName, Gauge<string>> = {
  faatora_clearance_queue_depth: clearanceQueueDepth,
  faatora_clearance_dlq_size: clearanceDlqSize,
  faatora_canary_last_success_timestamp: canaryLastSuccessTimestamp,
};

/** Increment a counter by name. Unknown names throw — this is a code bug. */
export function incCounter(
  name: CounterName,
  labels: Record<string, string | number> = {},
  value = 1,
): void {
  const counter = counters[name];
  if (!counter) throw new Error(`unknown counter: ${name}`);
  counter.inc(labels as Record<string, string | number>, value);
}

/** Observe a histogram sample (seconds) by name. */
export function observeHistogram(
  name: HistogramName,
  labels: Record<string, string | number>,
  seconds: number,
): void {
  const h = histograms[name];
  if (!h) throw new Error(`unknown histogram: ${name}`);
  h.observe(labels as Record<string, string | number>, seconds);
}

/** Set a gauge value. For label-less gauges pass `{}`. */
export function setGauge(
  name: GaugeName,
  labels: Record<string, string | number>,
  value: number,
): void {
  const g = gauges[name];
  if (!g) throw new Error(`unknown gauge: ${name}`);
  if (Object.keys(labels).length === 0) {
    g.set(value);
  } else {
    g.set(labels as Record<string, string | number>, value);
  }
}

/** Clear the entire registry — only used by tests. */
export function _resetRegistryForTests(): void {
  defaultRegistry.resetMetrics();
}
