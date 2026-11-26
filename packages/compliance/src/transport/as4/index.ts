/**
 * Barrel for the Peppol AS4 transport adapter.
 *
 * Consumers (application / NestJS services) should import from this
 * module rather than reaching into subfiles — the subfile layout may
 * still change as the direct-connect and partner-ASP paths both
 * mature.
 *
 * Grouping:
 *   - types + metadata + envelope + port: typed information model
 *   - adapters/mock + adapters/partner-asp-client: the existing
 *     mock sender and the §5.7-subcontractor skeleton
 *   - adapters/direct: the direct-connect AS4 sender composed from
 *     the modules below
 *   - xml/*: UserMessage, SOAP envelope, and receipt (de)serializers
 *   - signing/*: Signer port + XAdES-BES stub
 *   - http/*: mTLS HTTP client (fetch-shaped)
 *   - smp/*: SMP lookup types, parser, and client
 */

export * from './types.js';
export * from './metadata.js';
export * from './envelope.js';
export * from './port.js';
export * from './adapters/mock.js';
export * from './adapters/partner-asp-client.js';
export * from './adapters/direct.js';

// Direct-connect pieces.
export * from './xml/user-message-xml.js';
export * from './xml/soap-envelope.js';
export * from './xml/receipt-parser.js';
export * from './signing/signer.js';
export * from './signing/stub-signer.js';
export * from './http/mtls-client.js';
export * from './smp/types.js';
export * from './smp/parser.js';
export * from './smp/smp-client.js';
