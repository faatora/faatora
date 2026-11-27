/**
 * EP5 Wave 2 (W2-C) -- client list page tests.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import i18n from '../../../../i18n';
import { ClientListPage } from '../pages/ClientListPage';
import { FirmContextProvider } from '../../context/FirmContext';
import { ACTIVE_FIRM_STORAGE_KEY, IMPERSONATE_TENANT_STORAGE_KEY } from '../../../../lib/api';

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

function renderPage(
  opts: {
    firmId?: string;
    role?: 'owner' | 'partner' | 'staff' | 'read_only';
    onAddClient?: () => void;
    onViewInvoices?: (tenantId: string) => void;
  } = {},
) {
  const firmId = opts.firmId ?? 'firm-1';
  const role = opts.role ?? 'owner';
  localStorage.setItem(ACTIVE_FIRM_STORAGE_KEY, firmId);
  const seedFirms = [{ firm: { id: firmId, name: 'Test Firm' }, role }];
  // Tack the firms seed onto the /firms/mine call that FirmContext fires on mount.
  const existing = vi.spyOn(globalThis, 'fetch');
  if (existing.mock.calls.length === 0 && !existing.getMockImplementation()) {
    existing.mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.endsWith('/firms/mine')) return makeResponse(200, seedFirms);
      if (url.endsWith(`/firms/${firmId}/clients`)) return makeResponse(200, []);
      return makeResponse(404, {});
    });
  }
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={[`/firms/${firmId}/clients`]}>
        <FirmContextProvider>
          <Routes>
            <Route
              path="/firms/:id/clients"
              element={
                <ClientListPage
                  firmId={firmId}
                  onAddClient={opts.onAddClient}
                  onViewInvoices={opts.onViewInvoices}
                />
              }
            />
            <Route path="*" element={<LocationReporter />} />
          </Routes>
        </FirmContextProvider>
      </MemoryRouter>
    </I18nextProvider>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe('ClientListPage', () => {
  it('renders the fetched clients with name and engagement type', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.endsWith('/firms/mine')) {
        return makeResponse(200, [{ firm: { id: 'firm-1', name: 'Test Firm' }, role: 'owner' }]);
      }
      if (url.endsWith('/firms/firm-1/clients')) {
        return makeResponse(200, [
          {
            tenantId: 't1',
            tenantName: 'Alpha Co',
            accessLevel: 'full',
            engagementType: 'ongoing',
            createdAt: new Date().toISOString(),
          },
          {
            tenantId: 't2',
            tenantName: 'Beta Co',
            accessLevel: 'read_only',
            engagementType: 'periodic',
            createdAt: new Date().toISOString(),
          },
        ]);
      }
      return makeResponse(404, {});
    });

    renderPage();

    expect(await screen.findByText('Alpha Co')).toBeInTheDocument();
    expect(screen.getByText('Beta Co')).toBeInTheDocument();
  });

  it('filters by engagement type', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.endsWith('/firms/mine')) {
        return makeResponse(200, [{ firm: { id: 'firm-1', name: 'Test Firm' }, role: 'owner' }]);
      }
      if (url.endsWith('/firms/firm-1/clients')) {
        return makeResponse(200, [
          {
            tenantId: 't1',
            tenantName: 'Alpha Co',
            accessLevel: 'full',
            engagementType: 'ongoing',
            createdAt: 'x',
          },
          {
            tenantId: 't2',
            tenantName: 'Beta Co',
            accessLevel: 'full',
            engagementType: 'periodic',
            createdAt: 'x',
          },
        ]);
      }
      return makeResponse(404, {});
    });

    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Alpha Co');
    const engagementSelect = screen.getByLabelText(/engagement/i);
    await user.selectOptions(engagementSelect, 'periodic');
    await waitFor(() => expect(screen.queryByText('Alpha Co')).not.toBeInTheDocument());
    expect(screen.getByText('Beta Co')).toBeInTheDocument();
  });

  it('calls onAddClient when the Add button is clicked', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.endsWith('/firms/mine')) {
        return makeResponse(200, [{ firm: { id: 'firm-1', name: 'Test Firm' }, role: 'owner' }]);
      }
      return makeResponse(200, []);
    });
    const onAdd = vi.fn();
    const user = userEvent.setup();
    renderPage({ onAddClient: onAdd });
    await screen.findByText(/no clients yet/i);
    await user.click(screen.getByRole('button', { name: /add client/i }));
    expect(onAdd).toHaveBeenCalled();
  });

  it('shows an "Act as" button per row and starts impersonation on click', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.endsWith('/firms/mine')) {
        return makeResponse(200, [{ firm: { id: 'firm-1', name: 'Test Firm' }, role: 'owner' }]);
      }
      if (url.endsWith('/firms/firm-1/clients')) {
        return makeResponse(200, [
          {
            tenantId: 't-alpha',
            tenantName: 'Alpha Co',
            accessLevel: 'full',
            engagementType: 'ongoing',
            createdAt: 'x',
          },
        ]);
      }
      // startImpersonation POST — backend endpoint isn't live yet, so 404.
      if (init?.method === 'POST' && url.includes('/act-as')) {
        return makeResponse(404, { error: 'not implemented' });
      }
      return makeResponse(404, {});
    });

    const user = userEvent.setup();
    renderPage();
    const actAsBtn = await screen.findByRole('button', { name: /act as client alpha co/i });
    await user.click(actAsBtn);

    await waitFor(() => {
      expect(localStorage.getItem(IMPERSONATE_TENANT_STORAGE_KEY)).toBe('t-alpha');
    });
    // Navigation lands on root ('/'), so the LocationReporter renders.
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/'));
  });

  it('disables "Act as" for read-only firm members', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.endsWith('/firms/mine')) {
        return makeResponse(200, [
          { firm: { id: 'firm-1', name: 'Test Firm' }, role: 'read_only' },
        ]);
      }
      if (url.endsWith('/firms/firm-1/clients')) {
        return makeResponse(200, [
          {
            tenantId: 't-alpha',
            tenantName: 'Alpha Co',
            accessLevel: 'full',
            engagementType: 'ongoing',
            createdAt: 'x',
          },
        ]);
      }
      return makeResponse(404, {});
    });

    renderPage({ role: 'read_only' });
    const actAsBtn = await screen.findByRole('button', { name: /act as client alpha co/i });
    expect(actAsBtn).toBeDisabled();
  });
});
