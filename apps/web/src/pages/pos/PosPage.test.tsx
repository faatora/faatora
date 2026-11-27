import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import i18n from '../../i18n';
import { PosPage } from './PosPage';
import { ACCESS_TOKEN_STORAGE_KEY } from '../../lib/api';

function makeResponse(status: number, body: unknown) {
  const headers = new Headers({ 'content-type': 'application/json' });
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function LocationReporter() {
  const loc = useLocation();
  return <span data-testid="loc">{loc.pathname}</span>;
}

function renderAt(path: string) {
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/pos" element={<PosPage />} />
          <Route path="/pos/login" element={<LocationReporter />} />
          <Route path="*" element={<LocationReporter />} />
        </Routes>
      </MemoryRouter>
    </I18nextProvider>,
  );
}

describe('PosPage auth gate', () => {
  afterEach(() => vi.restoreAllMocks());

  it('redirects to /pos/login when no access token is stored', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(makeResponse(200, []));
    renderAt('/pos');
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/pos/login'));
  });

  it('renders the POS when a non-expired token is stored', async () => {
    // An opaque token (not a JWT) is treated as valid by isTokenExpired.
    localStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, 'opaque-token');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(makeResponse(200, []));
    renderAt('/pos');
    await screen.findByRole('heading', { name: /point of sale/i });
    expect(screen.queryByTestId('loc')).not.toBeInTheDocument();
  });

  it('clears an expired JWT and redirects to login', async () => {
    // Expired JWT: exp in 1970.
    const header = btoa(JSON.stringify({ alg: 'none', typ: 'JWT' }));
    const body = btoa(JSON.stringify({ exp: 1 }));
    const expiredJwt = `${header}.${body}.`;
    localStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, expiredJwt);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(makeResponse(200, []));
    renderAt('/pos');
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/pos/login'));
    expect(localStorage.getItem(ACCESS_TOKEN_STORAGE_KEY)).toBeNull();
  });
});
