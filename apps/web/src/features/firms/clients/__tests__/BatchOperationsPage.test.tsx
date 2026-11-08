/**
 * EP5 Wave 2 (W2-C) -- batch-operations page tests.
 */
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import i18n from '../../../../i18n';
import { BatchOperationsPage } from '../pages/BatchOperationsPage';

function makeResponse(status: number, body: unknown, ctype = 'application/json') {
  const headers = new Headers({ 'content-type': ctype });
  const txt = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    json: async () => (typeof body === 'string' ? body : body),
    text: async () => txt,
  } as unknown as Response;
}

function renderPage() {
  return render(
    <I18nextProvider i18n={i18n}>
      <BatchOperationsPage firmId="firm-op" />
    </I18nextProvider>,
  );
}

describe('BatchOperationsPage', () => {
  beforeEach(() => {
    // jsdom lacks URL.createObjectURL by default.
    if (!('createObjectURL' in URL)) {
      (URL as any).createObjectURL = vi.fn(() => 'blob:mock');
    }
    if (!('revokeObjectURL' in URL)) {
      (URL as any).revokeObjectURL = vi.fn();
    }
  });

  afterEach(() => vi.restoreAllMocks());

  it('runs validate-all and surfaces the per-tenant table', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.endsWith('/firms/firm-op/operations/validate-all') && init?.method === 'POST') {
        return makeResponse(200, {
          summary: { tenantsScanned: 2, totalDraft: 4, totalPassed: 3, totalFailed: 1 },
          perTenant: [
            {
              tenantId: 't1',
              tenantName: 'Alpha Co',
              totalDraft: 2,
              passed: 2,
              failed: 0,
              failures: [],
            },
            {
              tenantId: 't2',
              tenantName: 'Beta Co',
              totalDraft: 2,
              passed: 1,
              failed: 1,
              failures: [{ invoiceId: 'i1', number: 'B-002', errors: ['BR-07'] }],
            },
          ],
        });
      }
      return makeResponse(404, {});
    });

    renderPage();
    await user.click(screen.getByRole('button', { name: /run validation/i }));
    expect(await screen.findByText(/2 tenants/)).toBeInTheDocument();
    expect(screen.getByText('Alpha Co')).toBeInTheDocument();
    expect(screen.getByText('Beta Co')).toBeInTheDocument();
  });

  it('shows an error alert when validate-all fails', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => makeResponse(500, {}));
    renderPage();
    await user.click(screen.getByRole('button', { name: /run validation/i }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('download button is disabled until both dates are set, then fires the CSV GET', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes('/operations/vat-return.csv')) {
        return makeResponse(
          200,
          'tenantId,tenantName,vatin,invoiceCount,totalTaxableOmr,totalVatOmr,netOmr\nt1,Alpha,OM1,3,100.000,5.000,105.000\n',
          'text/csv; charset=utf-8',
        );
      }
      return makeResponse(404, {});
    });
    renderPage();

    const dl = screen.getByRole('button', { name: /download csv/i });
    expect(dl).toBeDisabled();

    const start = screen.getByLabelText(/period start/i) as HTMLInputElement;
    const end = screen.getByLabelText(/period end/i) as HTMLInputElement;
    // fireEvent on date inputs via userEvent requires typing the full value.
    await user.type(start, '2026-03-01');
    await user.type(end, '2026-03-31');

    await waitFor(() => expect(dl).toBeEnabled());
    await user.click(dl);

    await waitFor(() => {
      const called = fetchSpy.mock.calls.some(([u]) =>
        String(u).includes(
          '/operations/vat-return.csv?periodStart=2026-03-01&periodEnd=2026-03-31',
        ),
      );
      expect(called).toBe(true);
    });
  });
});
