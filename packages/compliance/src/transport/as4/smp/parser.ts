/**
 * Parser for an SMP `ServiceMetadata` response.
 *
 * The Oman SMP (OTA Oman SMP API Specifications v1.0) returns the
 * standard OASIS busdox ServiceMetadata XML on
 * `GET /{participantId}/services/{documentTypeId}`. The shape is:
 *
 *   smp:ServiceMetadata
 *     smp:ServiceInformation
 *       smp:ParticipantIdentifier
 *       smp:DocumentIdentifier
 *       smp:ProcessList
 *         smp:Process*
 *           smp:ProcessIdentifier
 *           smp:ServiceEndpointList
 *             smp:Endpoint* (@transportProfile)
 *
 * This parser is tolerant of namespace prefix variation (any prefix,
 * or none, maps to the right element) and ignores extra properties
 * the Oman SMP adds through `smp:Extension`. It does NOT verify a
 * ServiceMetadata signature; signature verification lives behind a
 * separate port once the production KMS wiring is in place.
 *
 * References:
 *   - OASIS busdox ServiceMetadata 1.0 schema
 *   - OpenPeppol SMP Specification v1.2 §5
 *   - OTA Oman SMP API Specifications v1.0 §2.2 (ServiceMetadataType, EndpointType)
 */

import { XMLParser } from 'fast-xml-parser';

import type { SmpEndpoint, SmpProcess, SmpServiceMetadata } from './types.js';

const PARSER = new XMLParser({
  attributeNamePrefix: '@_',
  ignoreAttributes: false,
  textNodeName: '#text',
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
  removeNSPrefix: true,
});

export class SmpParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmpParseError';
  }
}

/**
 * Parse an SMP ServiceMetadata response into our typed model.
 *
 * Throws `SmpParseError` on malformed XML or on a response that
 * does not look like a ServiceMetadata document (e.g. an SMP
 * redirect pointing to another SMP). A redirect is a legitimate SMP
 * response that we DO NOT follow in v1 — supporting it properly
 * needs a signed `smp:Redirect` chain verifier.
 */
export function parseSmpServiceMetadata(xml: string): SmpServiceMetadata {
  let root: unknown;
  try {
    root = PARSER.parse(xml);
  } catch (err) {
    throw new SmpParseError(
      `Malformed SMP XML: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!isObject(root)) throw new SmpParseError('SMP XML parse yielded no root');

  // The response may be wrapped in `SignedServiceMetadata` (when the
  // SMP returns a signed document) or come straight as
  // `ServiceMetadata`. Pick whichever is present.
  const sm = pickServiceMetadata(root);
  if (!sm) throw new SmpParseError('ServiceMetadata element not found');

  if (sm['Redirect'] !== undefined) {
    const href = pickAttr(sm['Redirect'], '@_href');
    throw new SmpParseError(
      `SMP returned a Redirect to '${href ?? 'unknown'}'; chained SMP lookups are not yet supported`,
    );
  }

  const si = sm['ServiceInformation'];
  if (!isObject(si)) throw new SmpParseError('ServiceInformation element missing');

  const participantId = idWithScheme(si['ParticipantIdentifier']);
  const documentTypeId = idWithScheme(si['DocumentIdentifier']);
  if (!participantId || !documentTypeId) {
    throw new SmpParseError('ParticipantIdentifier / DocumentIdentifier missing');
  }

  const processList = si['ProcessList'];
  if (!isObject(processList)) {
    throw new SmpParseError('ProcessList missing');
  }
  const processesRaw = processList['Process'];
  const processArray = toArray(processesRaw);
  const processes: SmpProcess[] = processArray.map(parseProcess);

  return {
    participantId,
    documentTypeId,
    processes,
  };
}

function parseProcess(p: unknown): SmpProcess {
  if (!isObject(p)) throw new SmpParseError('Process entry must be an object');
  const processId = idWithScheme(p['ProcessIdentifier']);
  if (!processId) throw new SmpParseError('ProcessIdentifier missing on Process');
  const sel = p['ServiceEndpointList'];
  if (!isObject(sel)) throw new SmpParseError('ServiceEndpointList missing');
  const endpoints = toArray(sel['Endpoint']).map(parseEndpoint);
  return { processId, endpoints };
}

function parseEndpoint(e: unknown): SmpEndpoint {
  if (!isObject(e)) throw new SmpParseError('Endpoint entry must be an object');
  const transportProfile = stringAttr(e, '@_transportProfile');
  if (!transportProfile) {
    throw new SmpParseError('Endpoint missing @transportProfile');
  }
  const endpointUrl = extractAddress(e['EndpointReference']);
  if (!endpointUrl) {
    throw new SmpParseError('Endpoint missing EndpointReference/Address');
  }
  const certificatePem = toText(e['Certificate']);
  if (!certificatePem) {
    throw new SmpParseError('Endpoint missing Certificate');
  }
  return {
    transportProfile,
    endpointUrl,
    requiresBusinessLevelSignature: parseBool(e['RequireBusinessLevelSignature']) ?? false,
    certificatePem: normalizePem(certificatePem),
    serviceDescription: toText(e['ServiceDescription']),
    technicalContactUrl: toText(e['TechnicalContactUrl']),
    serviceActivationDate: toText(e['ServiceActivationDate']),
    serviceExpirationDate: toText(e['ServiceExpirationDate']),
    minimumAuthenticationLevel: toText(e['MinimumAuthenticationLevel']),
  };
}

function pickServiceMetadata(root: Record<string, unknown>): Record<string, unknown> | undefined {
  // Common shapes we handle:
  //   ServiceMetadata              — bare
  //   SignedServiceMetadata        — wraps a ServiceMetadata child
  //   ServiceGroup                 — error case (wrong endpoint)
  if (isObject(root['ServiceMetadata'])) {
    const sm = root['ServiceMetadata'] as Record<string, unknown>;
    if (isObject(sm['ServiceInformation']) || isObject(sm['Redirect'])) return sm;
    // SignedServiceMetadata wraps ServiceMetadata, which wraps the
    // actual info. Unwrap one more layer.
    if (isObject(sm['ServiceMetadata'])) return sm['ServiceMetadata'] as Record<string, unknown>;
  }
  if (isObject(root['SignedServiceMetadata'])) {
    const ssm = root['SignedServiceMetadata'] as Record<string, unknown>;
    if (isObject(ssm['ServiceMetadata'])) return ssm['ServiceMetadata'] as Record<string, unknown>;
  }
  return undefined;
}

function idWithScheme(node: unknown): string | undefined {
  if (!isObject(node)) return undefined;
  const scheme = stringAttr(node, '@_scheme');
  const value = toText(node);
  if (!scheme || !value) return undefined;
  return `${scheme}::${value}`;
}

function extractAddress(ref: unknown): string | undefined {
  if (!isObject(ref)) return undefined;
  // The OTA SMP schema embeds a `wsa:Address` element inside
  // `EndpointReference`. After namespace stripping it is just
  // `Address`.
  const addr = ref['Address'];
  const text = toText(addr);
  if (text) return text;
  if (typeof addr === 'string') return addr;
  return undefined;
}

function toText(node: unknown): string | undefined {
  if (node === undefined || node === null) return undefined;
  if (typeof node === 'string') return node;
  if (isObject(node)) {
    const text = node['#text'];
    if (typeof text === 'string') return text;
  }
  return undefined;
}

function pickAttr(node: unknown, key: string): string | undefined {
  if (!isObject(node)) return undefined;
  return stringAttr(node, key);
}

function stringAttr(node: Record<string, unknown>, key: string): string | undefined {
  const v = node[key];
  return typeof v === 'string' ? v : undefined;
}

function parseBool(node: unknown): boolean | undefined {
  const text = toText(node);
  if (text === undefined) return undefined;
  const t = text.trim().toLowerCase();
  if (t === 'true' || t === '1') return true;
  if (t === 'false' || t === '0') return false;
  return undefined;
}

function toArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function normalizePem(raw: string): string {
  // SMP responses often carry just the base64 blob between BEGIN /
  // END markers, no line-wrap. If the body is not already PEM-wrapped
  // we add the markers so downstream `node:crypto` can parse it.
  if (raw.includes('-----BEGIN CERTIFICATE-----')) return raw.trim();
  const body = raw.replace(/\s+/g, '');
  if (body.length === 0) return raw;
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
