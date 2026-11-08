import { Injectable } from '@nestjs/common';

/**
 * Minimal failure-counting circuit breaker that fronts the TransmissionProvider.
 *
 * Thresholds (chosen to be conservative for Wave 3 — easily tunable later):
 *   FAILURE_THRESHOLD      3   consecutive failed submits
 *   OPEN_WINDOW_MS         60s short-circuit window after it trips
 *
 * While OPEN, the gateway's drainOnce skips the provider call but still
 * touches outbox.next_attempt_at so queued rows don't pile up at `now()`,
 * which would hammer the breaker check on every tick.
 *
 * This is intentionally in-memory and process-local: the gateway owns one
 * logical connection to the ASP, so there's no multi-replica state to share.
 */
export const CB_FAILURE_THRESHOLD = 3;
export const CB_OPEN_WINDOW_MS = 60_000;

@Injectable()
export class TransmissionCircuitBreaker {
  private consecutiveFailures = 0;
  private openUntil = 0;

  isOpen(nowMs: number = Date.now()): boolean {
    if (this.openUntil === 0) return false;
    if (nowMs < this.openUntil) return true;
    // Window expired → half-open: pretend closed, let the next attempt probe.
    this.openUntil = 0;
    this.consecutiveFailures = 0;
    return false;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.openUntil = 0;
  }

  recordFailure(nowMs: number = Date.now()): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= CB_FAILURE_THRESHOLD) {
      this.openUntil = nowMs + CB_OPEN_WINDOW_MS;
    }
  }

  /** Test / admin helper. */
  reset(): void {
    this.consecutiveFailures = 0;
    this.openUntil = 0;
  }

  /** Introspection for logging / /drain response. */
  snapshot() {
    return {
      consecutiveFailures: this.consecutiveFailures,
      openUntil: this.openUntil,
      isOpen: this.isOpen(),
    };
  }
}
