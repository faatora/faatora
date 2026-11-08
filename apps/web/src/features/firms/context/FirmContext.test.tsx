import { describe, expect, it, vi, afterEach } from 'vitest';
import { act, render, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { FirmContextProvider, useFirmContext } from './FirmContext';
import { ACTIVE_FIRM_STORAGE_KEY } from '../../../lib/api';

function mockFetchJson(body: unknown, status = 200) {
  const headers = new Headers({ 'content-type': 'application/json' });
  const res = {
    ok: status >= 200 && status < 300,
    status,
    headers,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(res);
}

function wrapper(children: ReactNode) {
  return <FirmContextProvider>{children}</FirmContextProvider>;
}

describe('FirmContext', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('falls back to SME mode when GET /firms/mine returns empty', async () => {
    mockFetchJson([]);
    const { result } = renderHook(() => useFirmContext(), {
      wrapper: ({ children }) => wrapper(children),
    });

    await waitFor(() => expect(result.current.state).toBe('ready'));
    expect(result.current.firmList).toEqual([]);
    expect(result.current.isFirmUser).toBe(false);
    expect(result.current.activeFirm).toBeNull();
    expect(localStorage.getItem(ACTIVE_FIRM_STORAGE_KEY)).toBeNull();
  });

  it('pre-selects stored firm when it exists in /firms/mine', async () => {
    localStorage.setItem(ACTIVE_FIRM_STORAGE_KEY, 'firm-b');
    mockFetchJson([
      { firm: { id: 'firm-a', name: 'Alpha' }, role: 'owner' },
      { firm: { id: 'firm-b', name: 'Beta' }, role: 'partner' },
    ]);

    const { result } = renderHook(() => useFirmContext(), {
      wrapper: ({ children }) => wrapper(children),
    });
    await waitFor(() => expect(result.current.state).toBe('ready'));
    expect(result.current.activeFirm?.id).toBe('firm-b');
    expect(result.current.isFirmUser).toBe(true);
  });

  it('falls back to the first firm when stored id is not a member', async () => {
    localStorage.setItem(ACTIVE_FIRM_STORAGE_KEY, 'firm-nope');
    mockFetchJson([
      { firm: { id: 'firm-a', name: 'Alpha' }, role: 'owner' },
      { firm: { id: 'firm-b', name: 'Beta' }, role: 'partner' },
    ]);
    const { result } = renderHook(() => useFirmContext(), {
      wrapper: ({ children }) => wrapper(children),
    });
    await waitFor(() => expect(result.current.state).toBe('ready'));
    expect(result.current.activeFirm?.id).toBe('firm-a');
    expect(localStorage.getItem(ACTIVE_FIRM_STORAGE_KEY)).toBe('firm-a');
  });

  it('switchFirm updates context and localStorage', async () => {
    mockFetchJson([
      { firm: { id: 'firm-a', name: 'Alpha' }, role: 'owner' },
      { firm: { id: 'firm-b', name: 'Beta' }, role: 'partner' },
    ]);
    const { result } = renderHook(() => useFirmContext(), {
      wrapper: ({ children }) => wrapper(children),
    });
    await waitFor(() => expect(result.current.state).toBe('ready'));

    act(() => {
      result.current.switchFirm('firm-b');
    });

    expect(localStorage.getItem(ACTIVE_FIRM_STORAGE_KEY)).toBe('firm-b');
    expect(result.current.activeFirm?.id).toBe('firm-b');
  });

  it('enters unauthenticated state on 401', async () => {
    const headers = new Headers({ 'content-type': 'application/json' });
    const res = {
      ok: false,
      status: 401,
      headers,
      json: async () => ({ error: 'nope' }),
      text: async () => 'nope',
    } as unknown as Response;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(res);

    const { result } = renderHook(() => useFirmContext(), {
      wrapper: ({ children }) => wrapper(children),
    });
    await waitFor(() => expect(result.current.state).toBe('unauthenticated'));
    expect(result.current.isFirmUser).toBe(false);
  });

  it('does not load on mount when loadOnMount=false (test-friendly default)', async () => {
    const spy = mockFetchJson([]);
    const { result } = renderHook(() => useFirmContext(), {
      wrapper: ({ children }) => (
        <FirmContextProvider loadOnMount={false}>{children}</FirmContextProvider>
      ),
    });
    await waitFor(() => expect(result.current.state).toBe('ready'));
    expect(spy).not.toHaveBeenCalled();
    expect(result.current.firmList).toEqual([]);
  });

  it('exposes a provider that renders its children', () => {
    mockFetchJson([]);
    const { getByText } = render(
      <FirmContextProvider loadOnMount={false}>
        <span>hello</span>
      </FirmContextProvider>,
    );
    expect(getByText('hello')).toBeInTheDocument();
  });
});
