/**
 * EP5 Wave 2 (W2-C) -- client-onboarding wizard tests.
 *
 * Covers the two modes end-to-end (without a router) and the CSV parser
 * utility that backs the batch mode.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import i18n from '../../../../i18n';
import { ClientOnboardingWizardPage } from '../pages/ClientOnboardingWizardPage';
import { mapCsvRows, parseCsv } from '../components/csvParser';

function makeResponse(status: number, body: unknown, ctype = 'application/json') {
  const headers = new Headers({ 'content-type': ctype });
  const txt = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    text: async () => txt,
  } as unknown as Response;
}

function renderWizard(onCompleted?: (r: unknown) => void) {
  return render(
    <I18nextProvider i18n={i18n}>
      <ClientOnboardingWizardPage firmId="firm-xyz" onCompleted={onCompleted as never} />
    </I18nextProvider>,
  );
}

describe('ClientOnboardingWizardPage -- single mode', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders in single mode by default and submits the onboard call', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.endsWith('/firms/firm-xyz/clients/onboard') && init?.method === 'POST') {
        return makeResponse(201, {
          id: 'link-1',
          firmId: 'firm-xyz',
          tenantId: 't-1',
          tenantName: 'Acme Trading',
          accessLevel: 'full',
          engagementType: 'ongoing',
          crNumber: 'CR-7',
          vatin: 'OM9',
          country: 'OM',
          createdAt: new Date().toISOString(),
        });
      }
      return makeResponse(404, {});
    });

    const onCompleted = vi.fn();
    renderWizard(onCompleted);

    await user.type(screen.getByLabelText(/client business name/i), 'Acme Trading');
    await user.type(screen.getByLabelText(/^CR number/i), 'CR-7');
    await user.type(screen.getByLabelText(/^VATIN/i), 'OM9');

    await user.click(screen.getByRole('button', { name: /^add client$/i }));

    await waitFor(() => expect(onCompleted).toHaveBeenCalledTimes(1));
    expect(fetchSpy).toHaveBeenCalled();
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({
      tenantName: 'Acme Trading',
      crNumber: 'CR-7',
      vatin: 'OM9',
      country: 'OM',
      accessLevel: 'full',
      engagementType: 'ongoing',
    });

    expect(await screen.findByRole('status')).toHaveTextContent(/acme trading/i);
  });

  it('disables submit until the required fields are filled', async () => {
    const user = userEvent.setup();
    renderWizard();
    const submit = screen.getByRole('button', { name: /^add client$/i });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText(/client business name/i), 'Acme');
    await user.type(screen.getByLabelText(/^CR number/i), 'CR-1');
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText(/^VATIN/i), 'OM1');
    expect(submit).toBeEnabled();
  });

  it('shows an inline error when the onboard call fails', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      makeResponse(409, { message: 'Duplicate VATIN' }),
    );
    renderWizard();
    await user.type(screen.getByLabelText(/client business name/i), 'Acme');
    await user.type(screen.getByLabelText(/^CR number/i), 'CR-1');
    await user.type(screen.getByLabelText(/^VATIN/i), 'OM1');
    await user.click(screen.getByRole('button', { name: /^add client$/i }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});

describe('ClientOnboardingWizardPage -- batch mode', () => {
  afterEach(() => vi.restoreAllMocks());

  it('toggles to batch mode and submits the parsed rows', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.endsWith('/firms/firm-xyz/clients/batch') && init?.method === 'POST') {
        return makeResponse(200, {
          created: [
            {
              id: 'l1',
              firmId: 'firm-xyz',
              tenantId: 't1',
              tenantName: 'Acme',
              accessLevel: 'full',
              engagementType: 'ongoing',
              crNumber: 'CR-A',
              vatin: 'OM-A',
              country: 'OM',
              createdAt: new Date().toISOString(),
            },
          ],
          failed: [],
        });
      }
      return makeResponse(404, {});
    });

    renderWizard();
    await user.click(screen.getByRole('tab', { name: /multiple from CSV/i }));
    const textarea = await screen.findByLabelText(/paste CSV/i);
    await user.type(textarea, 'tenantName,crNumber,vatin\nAcme,CR-A,OM-A');

    // Preview should surface the row.
    expect(await screen.findByText(/1 rows parsed/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /onboard 1 client/i }));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.clients).toHaveLength(1);
    expect(body.clients[0]).toMatchObject({
      tenantName: 'Acme',
      crNumber: 'CR-A',
      vatin: 'OM-A',
    });
    expect(await screen.findByText(/1 onboarded/)).toBeInTheDocument();
  });

  it('marks invalid rows in the preview so the submit excludes them', async () => {
    const user = userEvent.setup();
    renderWizard();
    await user.click(screen.getByRole('tab', { name: /multiple from CSV/i }));
    const textarea = await screen.findByLabelText(/paste CSV/i);
    // Second row has empty crNumber and vatin.
    await user.type(textarea, 'tenantName,crNumber,vatin\nAcme,CR-1,OM1\nBadRow,,');
    expect(await screen.findByText(/2 rows parsed/)).toBeInTheDocument();
    expect(screen.getByText(/1 with errors/)).toBeInTheDocument();
    // The submit button text reflects the valid-row count only.
    expect(screen.getByRole('button', { name: /onboard 1 client/i })).toBeEnabled();
  });
});

describe('csvParser', () => {
  it('parses a simple CSV with trailing newline', () => {
    const { headers, rows } = parseCsv('a,b,c\n1,2,3\n4,5,6\n');
    expect(headers).toEqual(['a', 'b', 'c']);
    expect(rows).toEqual([
      { a: '1', b: '2', c: '3' },
      { a: '4', b: '5', c: '6' },
    ]);
  });

  it('handles quoted fields with commas and escaped quotes', () => {
    const { rows } = parseCsv('name,notes\n"Acme, Inc.","he said ""hi"""\n');
    expect(rows).toEqual([{ name: 'Acme, Inc.', notes: 'he said "hi"' }]);
  });

  it('mapCsvRows normalises header case and underscores', () => {
    const mapped = mapCsvRows([
      {
        tenant_name: 'Acme',
        'CR Number': 'CR-1',
        VATIN: 'OM1',
      } as unknown as Record<string, string>,
    ]);
    expect(mapped[0].tenantName).toBe('Acme');
    expect(mapped[0].crNumber).toBe('CR-1');
    expect(mapped[0].vatin).toBe('OM1');
    expect(mapped[0]._errors).toEqual([]);
  });

  it('mapCsvRows reports missing required fields', () => {
    const mapped = mapCsvRows([
      { tenantName: 'Acme', crNumber: '', vatin: '' } as unknown as Record<string, string>,
    ]);
    expect(mapped[0]._errors.length).toBeGreaterThanOrEqual(2);
  });
});
