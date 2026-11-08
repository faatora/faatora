/**
 * W2-D — Import wizard tests. Covers the happy path (pick format, pick
 * tenant, upload, preview, commit) and a handful of error paths.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import i18n from '../../../i18n';
import { FirmContextProvider } from '../../firms/context/FirmContext';
import { ImportWizardPage } from './ImportWizardPage';

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

const FIRM_ID = 'firm-abc';
const TENANT_ID = '00000000-0000-4000-8000-00000000aaaa';

function stubClients() {
  return [
    {
      tenantId: TENANT_ID,
      tenantName: 'Acme Trading LLC',
      accessLevel: 'full',
      engagementType: 'ongoing',
      createdAt: '2026-01-01T00:00:00Z',
    },
  ];
}

function stubPreview(opts?: { duplicateRows?: number; errorRows?: number; errors?: unknown[] }) {
  const duplicateRows = opts?.duplicateRows ?? 0;
  const errorRows = opts?.errorRows ?? 0;
  const errors = opts?.errors ?? [];
  return {
    previewToken: 'tok.sig',
    rows: [
      {
        sourceRowNo: 2,
        invoiceNumber: 'INV-1',
        invoiceDate: '2026-01-05',
        buyerName: 'Alpha LLC',
        buyerVatin: 'OM11',
        currency: 'OMR',
        taxableAmount: 100,
        vatAmount: 5,
        totalAmount: 105,
        rowHash: 'h1',
        duplicate: duplicateRows > 0,
      },
    ],
    errors,
    headers: [
      'Date',
      'Voucher No.',
      'Party Ledger',
      'Party VATIN',
      'Taxable Amount',
      'VAT Amount',
      'Total Amount',
    ],
    mapping: {
      invoiceNumber: 'Voucher No.',
      invoiceDate: 'Date',
      buyerName: 'Party Ledger',
      buyerVatin: 'Party VATIN',
      taxableAmount: 'Taxable Amount',
      vatAmount: 'VAT Amount',
      totalAmount: 'Total Amount',
    },
    summary: {
      totalRows: 1 + errorRows,
      validRows: 1 - duplicateRows,
      errorRows,
      duplicateRows,
    },
  };
}

function renderPage() {
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={[`/firms/${FIRM_ID}/imports`]}>
        <FirmContextProvider loadOnMount={false}>
          <Routes>
            <Route path="/firms/:id/imports" element={<ImportWizardPage />} />
          </Routes>
        </FirmContextProvider>
      </MemoryRouter>
    </I18nextProvider>,
  );
}

describe('ImportWizardPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('step 1 shows all four source formats and gates Next behind a choice', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => makeResponse(200, stubClients()));
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByTestId('step-format')).toBeInTheDocument();
    expect(screen.getByTestId('format-tally_daybook_csv')).toBeInTheDocument();
    expect(screen.getByTestId('format-tally_sales_register_csv')).toBeInTheDocument();
    expect(screen.getByTestId('format-tally_xml')).toBeInTheDocument();
    expect(screen.getByTestId('format-zoho_books_csv')).toBeInTheDocument();
    const next = screen.getByTestId('next-to-tenant');
    expect(next).toBeDisabled();
    await user.click(screen.getByTestId('format-tally_sales_register_csv'));
    expect(screen.getByTestId('next-to-tenant')).toBeEnabled();
  });

  it('step 2 lists the firm clients fetched from the API', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes(`/firms/${FIRM_ID}/clients`)) return makeResponse(200, stubClients());
      return makeResponse(404, {});
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId('format-tally_sales_register_csv'));
    await user.click(screen.getByTestId('next-to-tenant'));
    expect(await screen.findByText('Acme Trading LLC')).toBeInTheDocument();
  });

  it('happy path: picks format, tenant, uploads, previews, and commits', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      const method = init?.method ?? 'GET';
      if (url.includes(`/firms/${FIRM_ID}/clients`)) {
        return makeResponse(200, stubClients());
      }
      if (method === 'POST' && url.includes('/imports/preview')) {
        return makeResponse(200, stubPreview());
      }
      if (method === 'POST' && url.endsWith('/imports/commit')) {
        return makeResponse(200, {
          batchId: 'batch-1',
          rowCountTotal: 1,
          rowCountCommitted: 1,
          rowCountSkipped: 0,
          rowCountErrored: 0,
        });
      }
      return makeResponse(404, {});
    });

    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId('format-tally_sales_register_csv'));
    await user.click(screen.getByTestId('next-to-tenant'));
    await user.click(await screen.findByTestId(`tenant-${TENANT_ID}`));
    await user.click(screen.getByTestId('next-to-upload'));

    const file = new File(['Date,Voucher No.\n'], 'tally.csv', { type: 'text/csv' });
    await user.upload(screen.getByTestId('file-input'), file);

    expect(await screen.findByTestId('step-review')).toBeInTheDocument();
    expect(screen.getByTestId('preview-summary')).toBeInTheDocument();
    expect(screen.getByTestId('preview-row-2')).toBeInTheDocument();

    await user.click(screen.getByTestId('commit-button'));
    expect(await screen.findByTestId('step-done')).toBeInTheDocument();

    // Confirm the preview call carried the sourceFormat + tenantId in the query string.
    const previewCall = fetchSpy.mock.calls.find(([u]) => String(u).includes('/imports/preview'));
    expect(previewCall).toBeTruthy();
    expect(String(previewCall![0])).toContain(`tenantId=${TENANT_ID}`);
    expect(String(previewCall![0])).toContain('sourceFormat=tally_sales_register_csv');
  });

  it('surfaces a server error from the preview step', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      const method = init?.method ?? 'GET';
      if (url.includes(`/firms/${FIRM_ID}/clients`)) {
        return makeResponse(200, stubClients());
      }
      if (method === 'POST' && url.includes('/imports/preview')) {
        return makeResponse(400, { message: 'Unrecognized Tally CSV layout' });
      }
      return makeResponse(404, {});
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId('format-tally_daybook_csv'));
    await user.click(screen.getByTestId('next-to-tenant'));
    await user.click(await screen.findByTestId(`tenant-${TENANT_ID}`));
    await user.click(screen.getByTestId('next-to-upload'));
    const file = new File(['garbage'], 'bad.csv', { type: 'text/csv' });
    await user.upload(screen.getByTestId('file-input'), file);
    await waitFor(() => expect(screen.getByTestId('upload-error')).toBeInTheDocument());
  });

  it('shows the per-row errors list when preview returned errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      const method = init?.method ?? 'GET';
      if (url.includes(`/firms/${FIRM_ID}/clients`)) {
        return makeResponse(200, stubClients());
      }
      if (method === 'POST' && url.includes('/imports/preview')) {
        return makeResponse(
          200,
          stubPreview({
            errorRows: 1,
            errors: [
              {
                sourceRowNo: 47,
                field: 'vatin',
                message: 'row 47: missing VATIN',
              },
            ],
          }),
        );
      }
      return makeResponse(404, {});
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId('format-tally_sales_register_csv'));
    await user.click(screen.getByTestId('next-to-tenant'));
    await user.click(await screen.findByTestId(`tenant-${TENANT_ID}`));
    await user.click(screen.getByTestId('next-to-upload'));
    const file = new File(['Date,Voucher No.\n'], 'tally.csv', { type: 'text/csv' });
    await user.upload(screen.getByTestId('file-input'), file);
    const errorList = await screen.findByTestId('error-list');
    expect(errorList).toBeInTheDocument();
    expect(errorList.textContent).toMatch(/row 47: missing VATIN/);
  });

  it('flags duplicate rows in the preview with amber styling', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      const method = init?.method ?? 'GET';
      if (url.includes(`/firms/${FIRM_ID}/clients`)) {
        return makeResponse(200, stubClients());
      }
      if (method === 'POST' && url.includes('/imports/preview')) {
        return makeResponse(200, stubPreview({ duplicateRows: 1 }));
      }
      return makeResponse(404, {});
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId('format-zoho_books_csv'));
    await user.click(screen.getByTestId('next-to-tenant'));
    await user.click(await screen.findByTestId(`tenant-${TENANT_ID}`));
    await user.click(screen.getByTestId('next-to-upload'));
    const file = new File(['Invoice Date,Invoice ID\n'], 'zoho.csv', { type: 'text/csv' });
    await user.upload(screen.getByTestId('file-input'), file);
    const row = await screen.findByTestId('preview-row-2');
    expect(row.className).toContain('amber');
    // With zero valid rows, Commit is disabled so the user cannot push duplicates through.
    expect(screen.getByTestId('commit-button')).toBeDisabled();
  });

  it('allows editing a column mapping inline before commit', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      const method = init?.method ?? 'GET';
      if (url.includes(`/firms/${FIRM_ID}/clients`)) {
        return makeResponse(200, stubClients());
      }
      if (method === 'POST' && url.includes('/imports/preview')) {
        return makeResponse(200, stubPreview());
      }
      return makeResponse(404, {});
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId('format-tally_sales_register_csv'));
    await user.click(screen.getByTestId('next-to-tenant'));
    await user.click(await screen.findByTestId(`tenant-${TENANT_ID}`));
    await user.click(screen.getByTestId('next-to-upload'));
    const file = new File(['Date,Voucher No.\n'], 'tally.csv', { type: 'text/csv' });
    await user.upload(screen.getByTestId('file-input'), file);

    const mappingEditor = await screen.findByTestId('mapping-editor');
    expect(mappingEditor).toBeInTheDocument();
    const invoiceNumberSelect = screen.getByTestId('mapping-invoiceNumber') as HTMLSelectElement;
    expect(invoiceNumberSelect.value).toBe('Voucher No.');
    await user.selectOptions(invoiceNumberSelect, 'Date');
    expect(invoiceNumberSelect.value).toBe('Date');
  });

  it('back navigation returns to the previous step', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => makeResponse(200, stubClients()));
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId('format-tally_xml'));
    await user.click(screen.getByTestId('next-to-tenant'));
    expect(screen.getByTestId('step-tenant')).toBeInTheDocument();
    // Back button on step 2.
    const back = screen.getByRole('button', { name: /back/i });
    await user.click(back);
    expect(screen.getByTestId('step-format')).toBeInTheDocument();
  });
});
