/**
 * SignInvoiceDto — intentionally empty.
 *
 * Prior to SEC-001 this carried a `ublXml` string the client built. The
 * signing endpoint now ignores the body entirely and rebuilds the UBL from
 * the DB row inside `SigningService.sign`.
 */
export class SignInvoiceDto {}
