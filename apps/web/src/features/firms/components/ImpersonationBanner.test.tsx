import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import i18n from '../../../i18n';
import { FirmContextProvider } from '../context/FirmContext';
import { ImpersonationBanner } from './ImpersonationBanner';
import { ACTIVE_FIRM_STORAGE_KEY, IMPERSONATE_TENANT_STORAGE_KEY } from '../../../lib/api';

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

function LocationReporter() {
  const loc = useLocation();
  return <span data-testid="loc">{loc.pathname}</span>;
}

function renderBanner(initialPath = '/firms/firm-a/dashboard') {
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={[initialPath]}>
        <FirmContextProvider>
          <ImpersonationBanner />
          <Routes>
            <Route path="*" element={<LocationReporter />} />
          </Routes>
        </FirmContextProvider>
      </MemoryRouter>
    </I18nextProvider>,
  );
}

describe('ImpersonationBanner', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders nothing when no impersonation is active', async () => {
    mockFetchJson([]);
    renderBanner();
    await waitFor(() => expect(screen.getByTestId('loc')).toBeInTheDocument());
    expect(screen.queryByTestId('impersonation-banner')).not.toBeInTheDocument();
  });

  it('renders the banner when an impersonation key is set', async () => {
    localStorage.setItem(IMPERSONATE_TENANT_STORAGE_KEY, 'client-abc');
    mockFetchJson([]);
    renderBanner();
    const banner = await screen.findByTestId('impersonation-banner');
    expect(banner).toBeInTheDocument();
    expect(banner.textContent).toMatch(/client-abc/);
    expect(screen.getByRole('button', { name: /stop acting as client/i })).toBeInTheDocument();
  });

  it('exits impersonation and navigates back to the firm clients list', async () => {
    localStorage.setItem(ACTIVE_FIRM_STORAGE_KEY, 'firm-a');
    localStorage.setItem(IMPERSONATE_TENANT_STORAGE_KEY, 'client-abc');
    mockFetchJson([{ firm: { id: 'firm-a', name: 'Alpha Firm' }, role: 'owner' }]);
    const user = userEvent.setup();
    renderBanner();

    await screen.findByTestId('impersonation-banner');
    await user.click(screen.getByRole('button', { name: /stop acting as client/i }));

    await waitFor(() => expect(localStorage.getItem(IMPERSONATE_TENANT_STORAGE_KEY)).toBeNull());
    await waitFor(() =>
      expect(screen.getByTestId('loc').textContent).toBe('/firms/firm-a/clients'),
    );
    expect(screen.queryByTestId('impersonation-banner')).not.toBeInTheDocument();
  });
});
