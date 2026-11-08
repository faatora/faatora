/**
 * Invoice state machine for the clearance pipeline.
 *
 * The full lifecycle is DRAFT -> VALIDATED -> SIGNED -> SUBMITTED ->
 * CLEARED | REJECTED -> ARCHIVED. The DRAFT -> VALIDATED and VALIDATED ->
 * SIGNED transitions are owned by InvoicesService (A3/A5) and SigningService
 * (A7); the clearance gateway owns SIGNED -> SUBMITTED and SUBMITTED ->
 * CLEARED | REJECTED. ARCHIVED is a Wave-4 concern handled by A17.
 *
 * This is a tiny, pure, in-process state machine: nothing talks to the
 * database. It exists so that the valid transitions and their actors are
 * declared in one place, the clearance-gateway service calls assertCanTransition
 * before each UPDATE, and the audit log in clearance_events always carries
 * the exact (from_state, to_state) pair.
 */

export type InvoiceState =
  'DRAFT' | 'VALIDATED' | 'SIGNED' | 'SUBMITTED' | 'CLEARED' | 'REJECTED' | 'ARCHIVED';

export type ClearanceActor = 'system' | 'user' | 'asp_callback';

interface Transition {
  from: InvoiceState;
  to: InvoiceState;
  actors: readonly ClearanceActor[];
}

/**
 * Only the transitions the clearance gateway drives are listed here. Everything
 * earlier in the pipeline (DRAFT->VALIDATED, VALIDATED->SIGNED) is enforced
 * by its owning module and does not need to pass through this guard.
 */
const CLEARANCE_TRANSITIONS: readonly Transition[] = [
  { from: 'SIGNED', to: 'SUBMITTED', actors: ['system', 'user'] },
  { from: 'SUBMITTED', to: 'CLEARED', actors: ['system', 'asp_callback'] },
  { from: 'SUBMITTED', to: 'REJECTED', actors: ['system', 'asp_callback'] },
] as const;

export class InvalidTransitionError extends Error {
  constructor(from: InvoiceState, to: InvoiceState, actor: ClearanceActor) {
    super(`Invalid clearance transition ${from} -> ${to} (actor=${actor})`);
    this.name = 'InvalidTransitionError';
  }
}

export function isValidTransition(
  from: InvoiceState,
  to: InvoiceState,
  actor: ClearanceActor,
): boolean {
  return CLEARANCE_TRANSITIONS.some(
    (t) => t.from === from && t.to === to && t.actors.includes(actor),
  );
}

export function assertCanTransition(
  from: InvoiceState,
  to: InvoiceState,
  actor: ClearanceActor,
): void {
  if (!isValidTransition(from, to, actor)) {
    throw new InvalidTransitionError(from, to, actor);
  }
}
