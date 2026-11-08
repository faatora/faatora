/**
 * The port the clearance gateway talks to. Any accredited ASP implementation
 * (stub for Wave 3, real HTTPS client for production) wires itself in behind
 * this interface, so swapping providers is a single-line change in
 * ClearanceModule's provider list.
 */
export const TRANSMISSION_PROVIDER = 'TRANSMISSION_PROVIDER';

/**
 * One submission attempt to the ASP. The idempotencyKey (= invoice document
 * UUID) means the ASP MUST return the same ASP reference for the same key
 * even if the request is replayed — this is how we survive crashes in the
 * middle of a drain.
 */
export interface TransmissionSubmission {
  tenantId: string;
  idempotencyKey: string;
  ublXml: string;
  signatureValue: string;
  invoiceUuid: string;
}

/**
 * Three outcomes the ASP can return synchronously:
 *   - 'cleared'           — OTA cleared the invoice in-line (reference included).
 *   - 'rejected'          — OTA rejected it in-line (reasons in raw response).
 *   - 'accepted_pending'  — ASP accepted the invoice and will call back later.
 */
export interface TransmissionResult {
  aspReference: string;
  synchronousStatus: 'cleared' | 'rejected' | 'accepted_pending';
  otaReference?: string;
  rawResponse?: unknown;
}

/**
 * Asynchronous OTA verdict pushed back to us by the ASP (or synthesised by
 * the stub-ASP's setTimeout). We match it to our row via aspReference.
 */
export interface TransmissionCallback {
  aspReference: string;
  status: 'cleared' | 'rejected';
  otaReference?: string;
  rejectionReasons?: string[];
  rawPayload: unknown;
}

export interface TransmissionProvider {
  submit(input: TransmissionSubmission): Promise<TransmissionResult>;
}
