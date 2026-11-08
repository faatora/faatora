import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import i18n from '../../../../i18n';
import { FirmContextProvider } from '../../context/FirmContext';
import { DashboardPage } from './DashboardPage';
import type { FirmDashboard } from '../api';

function makeResponse(status: number, body: unknown): Response {
  const headers = new Headers({ 'content-type': 'application/json' });
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function sampleDashboard(overrides: Partial<FirmDashboard> = {}): FirmDashboard {
  return {
    summary: {
      totalClients: 3,
      totalInvoices30d: 42,
      totalVatCollected30dOmr: '128.500',
      overdueInvoiceCount: 2,
      failedClearanceCount: 1,
      pendingSubmissionCount: 3,
      upcomingVatReturnCount: 3,
    },
    perClient: [
      {
        tenantId: 'tenant-alpha',
        tenantName: 'Alpha Trading',
        invoices30d: 15,
        vatCollected30dOmr: '42.000',
        lastSubmissionAt: '2026-11-04T10:12:00.000Z',
        openIssues: 1,
      },
      {
        tenantId: 'tenant-beta',
        tenantName: 'Beta Holdings',
        invoices30d: 10,
        vatCollected30dOmr: '36.500',
        lastSubmissionAt: null,
        openIssues: 0,
      },
      {
        tenantId: 'tenant-gamma',
        tenantName: 'Gamma Supplies',
        invoices30d: 17,
        vatCollected30dOmr: '50.000',
        lastSubmissionAt: '2026-11-07T08:00:00.000Z',
        openIssues: 0,
      },
    ],
    issues: [
      {
        severity: 'error',
        message: 'Invoice INV-A-9 was rejected by the clearance gateway',
        tenantId: 'tenant-alpha',
        invoiceId: 'inv-a-9',
        createdAt: '2026-11-07T09:00:00.000Z',
      },
      {
        severity: 'warning',
        message: 'Invoice INV-G-3 is missing a VAT total',
        tenantId: 'tenant-gamma',
        invoiceId: 'inv-g-3',
        createdAt: '2026-11-06T14:30:00.000Z',
      },
    ],
    vatReturnsDue: [
      {
        tenantId: 'tenant-alpha',
        tenantName: 'Alpha Trading',
        periodStart: '2026-10-01',
        periodEnd: '2026-12-31',
        dueDate: '2027-01-30',
        status: 'draft',
      },
      {
        tenantId: 'tenant-beta',
        tenantName: 'Beta Holdings',
        periodStart: '2026-10-01',
        periodEnd: '2026-12-31',
        dueDate: '2027-01-30',
        status: 'draft',
      },
    ],
    ...overrides,
  };
}

function renderAt(firmId: string, handler: typeof globalThis.fetch) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(handler);
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={[`/firms/${firmId}/dashboard`]}>
        <FirmContextProvider loadOnMount={false}>
          <Routes>
            <Route path="/firms/:id/dashboard" element={<DashboardPage />} />
          </Routes>
        </FirmContextProvider>
      </MemoryRouter>
    </I18nextProvider>,
  );
}

function dashboardHandler(firmId: string, body: unknown, status = 200): typeof globalThis.fetch {
  return (async (input: Parameters<typeof globalThis.fetch>[0]) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url.endsWith(`/firms/${firmId}/dashboard`)) {
      return makeResponse(status, body);
    }
    return makeResponse(404, {});
  }) as typeof globalThis.fetch;
}

describe('DashboardPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    try {
      localStorage.clear();
    } catch {
      /* ignore */
    }
  });

  it('shows a loading skeleton before data arrives', () => {
    // Pending fetch -> never resolves this frame.
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => undefined));
    render(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={['/firms/firm-x/dashboard']}>
          <FirmContextProvider loadOnMount={false}>
            <Routes>
              <Route path="/firms/:id/dashboard" element={<DashboardPage />} />
            </Routes>
          </FirmContextProvider>
        </MemoryRouter>
      </I18nextProvider>,
    );
    expect(screen.getByTestId('dashboard-loading')).toBeInTheDocument();
  });

  it('renders summary tiles with values from the API', async () => {
    renderAt('firm-x', dashboardHandler('firm-x', sampleDashboard()));
    await screen.findByTestId('dashboard-ready');

    const clients = screen.getByTestId('tile-clients');
    expect(clients).toHaveTextContent('Clients');
    expect(clients).toHaveTextContent('3');

    const vat = screen.getByTestId('tile-vat');
    expect(vat).toHaveTextContent('128.500');

    const invoices = screen.getByTestId('tile-invoices');
    expect(invoices).toHaveTextContent('42');

    expect(screen.getByTestId('tile-failed')).toHaveTextContent('1');
    expect(screen.getByTestId('tile-pending')).toHaveTextContent('3');
    expect(screen.getByTestId('tile-overdue')).toHaveTextContent('2');
  });

  it('renders the per-client table with one row per tenant', async () => {
    renderAt('firm-x', dashboardHandler('firm-x', sampleDashboard()));
    await screen.findByTestId('dashboard-ready');

    expect(screen.getByTestId('per-client-row-tenant-alpha')).toHaveTextContent('Alpha Trading');
    expect(screen.getByTestId('per-client-row-tenant-beta')).toHaveTextContent('Beta Holdings');
    expect(screen.getByTestId('per-client-row-tenant-gamma')).toHaveTextContent('Gamma Supplies');

    // Alpha has 1 open issue -> badge shows 1.
    const alphaRow = screen.getByTestId('per-client-row-tenant-alpha');
    expect(alphaRow).toHaveTextContent('1');
    // Beta row has 10 invoices.
    const betaRow = screen.getByTestId('per-client-row-tenant-beta');
    expect(betaRow).toHaveTextContent('10');
  });

  it('renders the issues panel with severity dots', async () => {
    renderAt('firm-x', dashboardHandler('firm-x', sampleDashboard()));
    await screen.findByTestId('dashboard-ready');
    const list = screen.getAllByTestId('dashboard-issue');
    expect(list).toHaveLength(2);
    expect(list[0]).toHaveTextContent(/rejected by the clearance gateway/i);
  });

  it('renders the upcoming VAT returns list', async () => {
    renderAt('firm-x', dashboardHandler('firm-x', sampleDashboard()));
    await screen.findByTestId('dashboard-ready');
    const items = screen.getAllByTestId('dashboard-vat-return');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Alpha Trading');
    // Default sample has all 'draft' status.
    expect(screen.getAllByTestId('vat-status-draft').length).toBeGreaterThan(0);
  });

  it('shows the empty state when the firm has no clients and links to onboarding', async () => {
    const emptyBody: FirmDashboard = {
      summary: {
        totalClients: 0,
        totalInvoices30d: 0,
        totalVatCollected30dOmr: '0',
        overdueInvoiceCount: 0,
        failedClearanceCount: 0,
        pendingSubmissionCount: 0,
        upcomingVatReturnCount: 0,
      },
      perClient: [],
      issues: [],
      vatReturnsDue: [],
    };
    renderAt('firm-empty', dashboardHandler('firm-empty', emptyBody));

    const empty = await screen.findByTestId('dashboard-empty');
    expect(empty).toBeInTheDocument();

    const link = screen.getByRole('link', { name: /onboard a client/i });
    expect(link).toHaveAttribute('href', '/firms/firm-empty/clients/new');
  });

  it('shows the error state when the API fails and allows retry', async () => {
    let calls = 0;
    const flaky: typeof globalThis.fetch = (async (
      input: Parameters<typeof globalThis.fetch>[0],
    ) => {
      calls += 1;
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.endsWith('/firms/firm-x/dashboard')) {
        if (calls === 1) return makeResponse(500, { error: 'boom' });
        return makeResponse(200, sampleDashboard());
      }
      return makeResponse(404, {});
    }) as typeof globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(flaky);

    render(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={['/firms/firm-x/dashboard']}>
          <FirmContextProvider loadOnMount={false}>
            <Routes>
              <Route path="/firms/:id/dashboard" element={<DashboardPage />} />
            </Routes>
          </FirmContextProvider>
        </MemoryRouter>
      </I18nextProvider>,
    );

    await screen.findByTestId('dashboard-error');
    await userEvent.click(screen.getByRole('button', { name: /retry/i }));
    await screen.findByTestId('dashboard-ready');
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('shows the sign-in state on 401', async () => {
    renderAt('firm-x', dashboardHandler('firm-x', { error: 'unauthorized' }, 401));
    expect(await screen.findByTestId('dashboard-sign-in')).toBeInTheDocument();
  });

  it('calls GET /firms/:id/dashboard once on mount', async () => {
    const spy = vi.fn(dashboardHandler('firm-mnt', sampleDashboard()));
    renderAt('firm-mnt', spy as unknown as typeof globalThis.fetch);
    await screen.findByTestId('dashboard-ready');
    await waitFor(() => {
      const dashboardCalls = spy.mock.calls.filter((c) => {
        const url = typeof c[0] === 'string' ? c[0] : (c[0] as Request).url;
        return url.includes('/firms/firm-mnt/dashboard');
      });
      expect(dashboardCalls.length).toBe(1);
    });
  });
});
