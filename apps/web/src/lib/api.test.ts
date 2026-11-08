import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ACTIVE_FIRM_STORAGE_KEY,
  apiGet,
  apiPost,
  buildDefaultHeaders,
  getActiveFirmId,
  setActiveFirmId,
  UnauthorizedError,
} from './api';

interface MockResponseInit {
  status?: number;
  body?: unknown;
  contentType?: string | null;
}

function mockFetchOnce({ status = 200, body, contentType = 'application/json' }: MockResponseInit) {
  const headers = new Headers();
  if (contentType) headers.set('content-type', contentType);
  const response = {
    ok: status >= 200 && status < 300,
    status,
    headers,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
  const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
  return spy;
}

describe('shared api client', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('omits x-firm-id when no firm is active (SME mode preserved)', async () => {
    const spy = mockFetchOnce({ body: { ok: true } });
    await apiGet('/some/path');
    const [, init] = spy.mock.calls[0];
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers['x-firm-id']).toBeUndefined();
    expect(headers['x-correlation-id']).toBeDefined();
  });

  it('injects x-firm-id when activeFirmId is set in localStorage', async () => {
    setActiveFirmId('firm-42');
    const spy = mockFetchOnce({ body: { ok: true } });
    await apiGet('/anywhere');
    const headers = spy.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers['x-firm-id']).toBe('firm-42');
  });

  it('adds Authorization bearer when a token is in localStorage', async () => {
    localStorage.setItem('fawtara_access_token', 'tok-abc');
    const spy = mockFetchOnce({ body: { ok: true } });
    await apiGet('/anything');
    const headers = spy.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer tok-abc');
  });

  it('serialises object bodies as JSON and sets Content-Type', async () => {
    const spy = mockFetchOnce({ status: 201, body: { id: 'x' } });
    await apiPost('/firms', { name: 'Acme' });
    const [, init] = spy.mock.calls[0];
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ name: 'Acme' }));
    const headers = init?.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('throws UnauthorizedError on 401', async () => {
    mockFetchOnce({ status: 401, body: { error: 'nope' } });
    await expect(apiGet('/firms/mine')).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('setActiveFirmId(null) clears the active firm', () => {
    setActiveFirmId('firm-7');
    expect(getActiveFirmId()).toBe('firm-7');
    setActiveFirmId(null);
    expect(getActiveFirmId()).toBeNull();
    expect(localStorage.getItem(ACTIVE_FIRM_STORAGE_KEY)).toBeNull();
  });

  it('buildDefaultHeaders only contains correlation id for anonymous SME user', () => {
    const headers = buildDefaultHeaders();
    expect(Object.keys(headers)).toEqual(['x-correlation-id']);
  });
});
