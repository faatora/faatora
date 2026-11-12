/**
 * Barrel for the Peppol AS4 transport adapter scaffold.
 *
 * Consumers (application / NestJS services) should import from this
 * module rather than reaching into subfiles — the subfile layout may
 * change when we wire the real partner-ASP HTTP client.
 */

export * from './types.js';
export * from './metadata.js';
export * from './envelope.js';
export * from './port.js';
export * from './adapters/mock.js';
export * from './adapters/partner-asp-client.js';
