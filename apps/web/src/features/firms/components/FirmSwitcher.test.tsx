import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import i18n from '../../../i18n';
import { FirmContextProvider } from '../context/FirmContext';
import { FirmSwitcher } from './FirmSwitcher';
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

function LocationReporter() {
  const loc = useLocation();
  return <span data-testid="loc">{loc.pathname}</span>;
}

function renderSwitcher(firms: Array<{ firm: { id: string; name: string }; role: string }>) {
  mockFetchJson(firms);
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={['/firms/firm-a/members']}>
        <FirmContextProvider>
          <Routes>
            <Route
              path="*"
              element={
                <>
                  <FirmSwitcher />
                  <LocationReporter />
                </>
              }
            />
          </Routes>
        </FirmContextProvider>
      </MemoryRouter>
    </I18nextProvider>,
  );
}

describe('FirmSwitcher', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the active firm name after loading', async () => {
    const firms = [
      { firm: { id: 'firm-a', name: 'Alpha Firm' }, role: 'owner' },
      { firm: { id: 'firm-b', name: 'Beta Firm' }, role: 'partner' },
      { firm: { id: 'firm-c', name: 'Gamma Firm' }, role: 'staff' },
    ];
    renderSwitcher(firms);
    await waitFor(() => expect(screen.getByText('Alpha Firm')).toBeInTheDocument());
  });

  it('lists all firms in the menu when opened', async () => {
    const user = userEvent.setup();
    const firms = [
      { firm: { id: 'firm-a', name: 'Alpha Firm' }, role: 'owner' },
      { firm: { id: 'firm-b', name: 'Beta Firm' }, role: 'partner' },
      { firm: { id: 'firm-c', name: 'Gamma Firm' }, role: 'staff' },
    ];
    renderSwitcher(firms);
    await waitFor(() => screen.getByText('Alpha Firm'));
    await user.click(screen.getByRole('button', { name: /switch firm/i }));

    const menu = await screen.findByRole('menu');
    expect(menu).toBeInTheDocument();
    expect(screen.getAllByText('Beta Firm').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Gamma Firm').length).toBeGreaterThan(0);
  });

  it('switches active firm and navigates to its dashboard on click', async () => {
    const user = userEvent.setup();
    const firms = [
      { firm: { id: 'firm-a', name: 'Alpha Firm' }, role: 'owner' },
      { firm: { id: 'firm-b', name: 'Beta Firm' }, role: 'partner' },
      { firm: { id: 'firm-c', name: 'Gamma Firm' }, role: 'staff' },
    ];
    renderSwitcher(firms);
    await waitFor(() => screen.getByText('Alpha Firm'));
    await user.click(screen.getByRole('button', { name: /switch firm/i }));
    await screen.findByRole('menu');
    const betaButton = screen.getByRole('menuitemradio', { name: /beta firm/i });
    await user.click(betaButton);

    expect(localStorage.getItem(ACTIVE_FIRM_STORAGE_KEY)).toBe('firm-b');
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/firms/firm-b/dashboard'));
  });

  it('shows create-firm and accept-invitation entries at the bottom', async () => {
    const user = userEvent.setup();
    renderSwitcher([]);
    // With no firms the button still shows the placeholder label, menu still opens.
    await waitFor(() => screen.getByRole('button', { name: /switch firm/i }));
    await user.click(screen.getByRole('button', { name: /switch firm/i }));
    expect(await screen.findByRole('menuitem', { name: /create firm/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /accept invitation/i })).toBeInTheDocument();
  });
});
