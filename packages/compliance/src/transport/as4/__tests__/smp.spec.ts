import type { MtlsHttpClient } from '../http/mtls-client.js';
import { makeIso6523ParticipantId, PEPPOL_BIS_BILLING_3_INVOICE } from '../metadata.js';
import { parseSmpServiceMetadata, SmpParseError } from '../smp/parser.js';
import {
  OMAN_T_SMP_BASE_URL,
  SmpClient,
  SmpEndpointNotFoundError,
  SmpLookupError,
} from '../smp/smp-client.js';

const SMP_AS4_V20_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<smp:ServiceMetadata xmlns:smp="http://busdox.org/serviceMetadata/publishing/1.0/"
                     xmlns:wsa="http://www.w3.org/2005/08/addressing"
                     xmlns:id="http://busdox.org/transport/identifiers/1.0/">
  <smp:ServiceInformation>
    <id:ParticipantIdentifier scheme="iso6523-actorid-upis">9915:om-buyer-9</id:ParticipantIdentifier>
    <id:DocumentIdentifier scheme="busdox-docid-qns">urn:oasis:names:specification:ubl:schema:xsd:Invoice-2::Invoice##urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0::2.1</id:DocumentIdentifier>
    <smp:ProcessList>
      <smp:Process>
        <id:ProcessIdentifier scheme="cenbii-procid-ubl">urn:fdc:peppol.eu:2017:poacc:billing:01:1.0</id:ProcessIdentifier>
        <smp:ServiceEndpointList>
          <smp:Endpoint transportProfile="peppol-transport-as4-v2_0">
            <wsa:EndpointReference>
              <wsa:Address>https://ap.taxoman.gov.om/as4/receive</wsa:Address>
            </wsa:EndpointReference>
            <smp:RequireBusinessLevelSignature>true</smp:RequireBusinessLevelSignature>
            <smp:Certificate>MIIBdummyAS4certMustBeReplaced==</smp:Certificate>
            <smp:ServiceDescription>Oman OTA AS4 Receive</smp:ServiceDescription>
            <smp:TechnicalContactUrl>https://taxoman.gov.om/support</smp:TechnicalContactUrl>
          </smp:Endpoint>
        </smp:ServiceEndpointList>
      </smp:Process>
    </smp:ProcessList>
  </smp:ServiceInformation>
</smp:ServiceMetadata>`;

const SMP_MULTI_PROFILE_SAMPLE = SMP_AS4_V20_SAMPLE.replace(
  '<smp:Endpoint transportProfile="peppol-transport-as4-v2_0">',
  `<smp:Endpoint transportProfile="peppol-transport-as4-v3_0">
            <wsa:EndpointReference>
              <wsa:Address>https://ap.taxoman.gov.om/as4-v3/receive</wsa:Address>
            </wsa:EndpointReference>
            <smp:RequireBusinessLevelSignature>false</smp:RequireBusinessLevelSignature>
            <smp:Certificate>MIIBdummyv3cert==</smp:Certificate>
          </smp:Endpoint>
          <smp:Endpoint transportProfile="peppol-transport-as4-v2_0">`,
);

const SMP_REDIRECT_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<smp:ServiceMetadata xmlns:smp="http://busdox.org/serviceMetadata/publishing/1.0/">
  <smp:Redirect href="https://other-smp.example.com/redirect" CertificateUID="urn:x:y"/>
</smp:ServiceMetadata>`;

/* -------------------------------------------------------------------------- */
/* parseSmpServiceMetadata                                                    */
/* -------------------------------------------------------------------------- */

describe('parseSmpServiceMetadata — happy path', () => {
  it('extracts participant, document type, process, and endpoint', () => {
    const sm = parseSmpServiceMetadata(SMP_AS4_V20_SAMPLE);
    expect(sm.participantId).toBe('iso6523-actorid-upis::9915:om-buyer-9');
    expect(sm.documentTypeId).toContain('urn:oasis:names:specification:ubl:schema:xsd:Invoice-2');
    expect(sm.processes).toHaveLength(1);
    const process = sm.processes[0];
    expect(process.processId).toBe(
      'cenbii-procid-ubl::urn:fdc:peppol.eu:2017:poacc:billing:01:1.0',
    );
    expect(process.endpoints).toHaveLength(1);
    const endpoint = process.endpoints[0];
    expect(endpoint.transportProfile).toBe('peppol-transport-as4-v2_0');
    expect(endpoint.endpointUrl).toBe('https://ap.taxoman.gov.om/as4/receive');
    expect(endpoint.requiresBusinessLevelSignature).toBe(true);
    expect(endpoint.serviceDescription).toBe('Oman OTA AS4 Receive');
    expect(endpoint.technicalContactUrl).toBe('https://taxoman.gov.om/support');
    expect(endpoint.certificatePem).toContain('-----BEGIN CERTIFICATE-----');
    expect(endpoint.certificatePem).toContain('MIIBdummyAS4certMustBeReplaced==');
  });

  it('parses multiple endpoints in one process', () => {
    const sm = parseSmpServiceMetadata(SMP_MULTI_PROFILE_SAMPLE);
    expect(sm.processes[0].endpoints).toHaveLength(2);
    const profiles = sm.processes[0].endpoints.map((e) => e.transportProfile);
    expect(profiles).toEqual(['peppol-transport-as4-v3_0', 'peppol-transport-as4-v2_0']);
  });

  it('keeps an already-PEM certificate unchanged', () => {
    const pem = '-----BEGIN CERTIFICATE-----\nMIIBalreadyWrapped==\n-----END CERTIFICATE-----';
    const xml = SMP_AS4_V20_SAMPLE.replace(
      '<smp:Certificate>MIIBdummyAS4certMustBeReplaced==</smp:Certificate>',
      `<smp:Certificate>${pem}</smp:Certificate>`,
    );
    const sm = parseSmpServiceMetadata(xml);
    expect(sm.processes[0].endpoints[0].certificatePem).toBe(pem);
  });
});

describe('parseSmpServiceMetadata — error paths', () => {
  it('rejects malformed XML', () => {
    expect(() => parseSmpServiceMetadata('<not-valid')).toThrow(SmpParseError);
  });

  it('rejects a document with no ServiceMetadata root', () => {
    expect(() => parseSmpServiceMetadata('<Root/>')).toThrow(/ServiceMetadata/);
  });

  it('rejects a Redirect response for now', () => {
    expect(() => parseSmpServiceMetadata(SMP_REDIRECT_SAMPLE)).toThrow(/Redirect/);
  });

  it('rejects a ServiceMetadata that lacks an Endpoint', () => {
    const noEndpoint = SMP_AS4_V20_SAMPLE.replace(/<smp:Endpoint[\s\S]*<\/smp:Endpoint>/, '');
    expect(() => parseSmpServiceMetadata(noEndpoint)).toThrow(SmpParseError);
  });
});

/* -------------------------------------------------------------------------- */
/* SmpClient                                                                  */
/* -------------------------------------------------------------------------- */

class FakeMtlsHttpClient implements MtlsHttpClient {
  readonly calls: Array<{ url: string; init?: RequestInit }> = [];
  readonly agent = {} as MtlsHttpClient['agent'];

  constructor(private readonly responder: (url: string) => Promise<Response> | Response) {}

  async fetch(url: string, init?: RequestInit): Promise<Response> {
    this.calls.push({ url, init });
    return this.responder(url);
  }
}

const buyer = makeIso6523ParticipantId('9915', 'om-buyer-9');

describe('SmpClient — URL composition', () => {
  it('builds a URL-encoded path per OpenPeppol SMP v1.2 §5.1.1', () => {
    const client = new SmpClient({
      baseUrl: OMAN_T_SMP_BASE_URL,
      httpClient: new FakeMtlsHttpClient(async () => new Response(SMP_AS4_V20_SAMPLE)),
    });
    const url = client.urlFor(buyer, PEPPOL_BIS_BILLING_3_INVOICE);
    // Separators ::, #, and ## must be percent-encoded.
    expect(url).toContain('iso6523-actorid-upis%3A%3A9915%3Aom-buyer-9');
    expect(url).toContain('/services/');
    expect(url).toContain('%23%23urn%3Acen.eu%3Aen16931%3A2017%23compliant');
  });

  it('strips a trailing slash from baseUrl', () => {
    const client = new SmpClient({
      baseUrl: OMAN_T_SMP_BASE_URL + '/',
      httpClient: new FakeMtlsHttpClient(async () => new Response(SMP_AS4_V20_SAMPLE)),
    });
    expect(client.urlFor(buyer, PEPPOL_BIS_BILLING_3_INVOICE)).not.toContain('wrapper//');
  });
});

describe('SmpClient.lookupAs4Endpoint — happy path', () => {
  it('fetches, parses, and returns the AS4 v2.0 endpoint', async () => {
    const http = new FakeMtlsHttpClient(async () => new Response(SMP_AS4_V20_SAMPLE));
    const client = new SmpClient({ baseUrl: OMAN_T_SMP_BASE_URL, httpClient: http });
    const resolved = await client.lookupAs4Endpoint(buyer, PEPPOL_BIS_BILLING_3_INVOICE);
    expect(resolved.endpoint.endpointUrl).toBe('https://ap.taxoman.gov.om/as4/receive');
    expect(resolved.endpoint.transportProfile).toBe('peppol-transport-as4-v2_0');
    expect(resolved.serviceMetadata.participantId).toBe('iso6523-actorid-upis::9915:om-buyer-9');
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0].init?.method).toBe('GET');
    const headers = http.calls[0].init?.headers as Record<string, string> | undefined;
    expect(headers?.Accept).toBe('application/xml');
  });

  it('prefers the configured transport profile when multiple endpoints are returned', async () => {
    const http = new FakeMtlsHttpClient(async () => new Response(SMP_MULTI_PROFILE_SAMPLE));
    const client = new SmpClient({ baseUrl: OMAN_T_SMP_BASE_URL, httpClient: http });
    const resolved = await client.lookupAs4Endpoint(buyer, PEPPOL_BIS_BILLING_3_INVOICE);
    expect(resolved.endpoint.transportProfile).toBe('peppol-transport-as4-v2_0');
    expect(resolved.endpoint.endpointUrl).toBe('https://ap.taxoman.gov.om/as4/receive');
  });

  it('accepts a caller-specified preferred transport profile', async () => {
    const http = new FakeMtlsHttpClient(async () => new Response(SMP_MULTI_PROFILE_SAMPLE));
    const client = new SmpClient({
      baseUrl: OMAN_T_SMP_BASE_URL,
      httpClient: http,
      preferredTransportProfile: 'peppol-transport-as4-v3_0',
    });
    const resolved = await client.lookupAs4Endpoint(buyer, PEPPOL_BIS_BILLING_3_INVOICE);
    expect(resolved.endpoint.transportProfile).toBe('peppol-transport-as4-v3_0');
  });
});

describe('SmpClient.lookupAs4Endpoint — error paths', () => {
  it('maps a 404 to SmpEndpointNotFoundError', async () => {
    const http = new FakeMtlsHttpClient(async () => new Response('not found', { status: 404 }));
    const client = new SmpClient({ baseUrl: OMAN_T_SMP_BASE_URL, httpClient: http });
    await expect(
      client.lookupAs4Endpoint(buyer, PEPPOL_BIS_BILLING_3_INVOICE),
    ).rejects.toBeInstanceOf(SmpEndpointNotFoundError);
  });

  it('maps a 500 to SmpHttpError with the response body attached', async () => {
    const http = new FakeMtlsHttpClient(async () => new Response('smp down', { status: 500 }));
    const client = new SmpClient({ baseUrl: OMAN_T_SMP_BASE_URL, httpClient: http });
    await expect(
      client.lookupAs4Endpoint(buyer, PEPPOL_BIS_BILLING_3_INVOICE),
    ).rejects.toMatchObject({ name: 'SmpHttpError', status: 500, responseBody: 'smp down' });
  });

  it('wraps a thrown fetch error in SmpLookupError', async () => {
    const http = new FakeMtlsHttpClient(() => {
      throw new Error('ECONNRESET');
    });
    const client = new SmpClient({ baseUrl: OMAN_T_SMP_BASE_URL, httpClient: http });
    await expect(
      client.lookupAs4Endpoint(buyer, PEPPOL_BIS_BILLING_3_INVOICE),
    ).rejects.toBeInstanceOf(SmpLookupError);
  });

  it('throws SmpLookupError when the SMP returns garbage', async () => {
    const http = new FakeMtlsHttpClient(
      async () => new Response('<not-service-metadata/>', { status: 200 }),
    );
    const client = new SmpClient({ baseUrl: OMAN_T_SMP_BASE_URL, httpClient: http });
    await expect(
      client.lookupAs4Endpoint(buyer, PEPPOL_BIS_BILLING_3_INVOICE),
    ).rejects.toBeInstanceOf(SmpLookupError);
  });

  it('throws SmpEndpointNotFoundError when no matching profile is present', async () => {
    const onlyV3 = SMP_AS4_V20_SAMPLE.replace(
      'transportProfile="peppol-transport-as4-v2_0"',
      'transportProfile="peppol-transport-as4-v3_0"',
    );
    const http = new FakeMtlsHttpClient(async () => new Response(onlyV3));
    const client = new SmpClient({ baseUrl: OMAN_T_SMP_BASE_URL, httpClient: http });
    await expect(
      client.lookupAs4Endpoint(buyer, PEPPOL_BIS_BILLING_3_INVOICE),
    ).rejects.toBeInstanceOf(SmpEndpointNotFoundError);
  });
});
