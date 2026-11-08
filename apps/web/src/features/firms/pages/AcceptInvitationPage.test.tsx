import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import i18n from '../../../i18n';
import { FirmContextProvider } from '../context/FirmContext';
import { AcceptInvitationPage } from './AcceptInvitationPage';
import { ACTIVE_FIRM_STORAGE_KEY } from '../../../lib/api';

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

function renderAt(route: string) {
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={[route]}>
        <FirmContextProvider loadOnMount={false}>
          <Routes>
            <Route path="/firms/invitations/accept" element={<AcceptInvitationPage />} />
            <Route path="*" element={<LocationReporter />} />
          </Routes>
        </FirmContextProvider>
      </MemoryRouter>
    </I18nextProvider>,
  );
}

describe('AcceptInvitationPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows a missing-token warning when no token is in the URL', async () => {
    renderAt('/firms/invitations/accept');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/No invitation token/i);
  });

  it('accepts a valid token and routes to the firm dashboard', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (init?.method === 'POST' && url.endsWith('/firms/invitations/accept')) {
        return makeResponse(200, { firmId: 'firm-9' });
      }
      if (url.endsWith('/firms/mine')) {
        return makeResponse(200, [{ firm: { id: 'firm-9', name: 'Delta' }, role: 'staff' }]);
      }
      return makeResponse(404, {});
    });

    renderAt('/firms/invitations/accept?token=abc.def');

    await waitFor(() => {
      expect(screen.getByTestId('loc').textContent).toBe('/firms/firm-9/dashboard');
    });
    expect(localStorage.getItem(ACTIVE_FIRM_STORAGE_KEY)).toBe('firm-9');
    const postCall = fetchSpy.mock.calls.find((c) => (c[1] as RequestInit)?.method === 'POST')!;
    expect(postCall[1]?.body).toBe(JSON.stringify({ token: 'abc.def' }));
  });

  it('shows an error and allows retry when the accept call fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(makeResponse(400, { error: 'bad token' }));
    renderAt('/firms/invitations/accept?token=stale');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/could not accept/i);
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });
});
