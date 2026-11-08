import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import i18n from '../../../i18n';
import { FirmContextProvider } from '../context/FirmContext';
import { FirmBootstrapPage } from './FirmBootstrapPage';

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

function renderPage() {
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={['/firms/new']}>
        <FirmContextProvider loadOnMount={false}>
          <Routes>
            <Route path="/firms/new" element={<FirmBootstrapPage />} />
            <Route path="/firms/:id/dashboard" element={<LocationReporter />} />
            <Route path="*" element={<LocationReporter />} />
          </Routes>
        </FirmContextProvider>
      </MemoryRouter>
    </I18nextProvider>,
  );
}

describe('FirmBootstrapPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('disables submit until all required fields are filled', async () => {
    const user = userEvent.setup();
    renderPage();
    const submit = screen.getByRole('button', { name: /create firm/i });
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText(/Firm name/i), 'Acme');
    await user.type(screen.getByLabelText(/Legal name/i), 'Acme LLC');
    await user.type(screen.getByLabelText(/CR number/i), 'CR1234');
    await user.type(screen.getByLabelText(/Contact email/i), 'owner@acme.om');
    await user.type(screen.getByLabelText(/Contact phone/i), '+96899123456');

    expect(submit).toBeEnabled();
  });

  it('POSTs to /firms with the form payload and routes to the dashboard on success', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (init?.method === 'POST' && url.endsWith('/firms')) {
        return makeResponse(201, { id: 'firm-new', name: 'Acme' });
      }
      if (url.endsWith('/firms/mine')) {
        return makeResponse(200, [{ firm: { id: 'firm-new', name: 'Acme' }, role: 'owner' }]);
      }
      return makeResponse(404, {});
    });

    renderPage();
    await user.type(screen.getByLabelText(/Firm name/i), 'Acme');
    await user.type(screen.getByLabelText(/Legal name/i), 'Acme LLC');
    await user.type(screen.getByLabelText(/CR number/i), 'CR1234');
    await user.type(screen.getByLabelText(/VAT number/i), 'OM1100000001');
    await user.type(screen.getByLabelText(/Contact email/i), 'owner@acme.om');
    await user.type(screen.getByLabelText(/Contact phone/i), '+96899123456');

    await user.click(screen.getByRole('button', { name: /create firm/i }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const postCall = fetchSpy.mock.calls.find((c) => (c[1] as RequestInit)?.method === 'POST');
    expect(postCall).toBeDefined();
    const [, init] = postCall!;
    expect(init?.body).toBe(
      JSON.stringify({
        name: 'Acme',
        legal_name: 'Acme LLC',
        cr_number: 'CR1234',
        email: 'owner@acme.om',
        phone: '+96899123456',
        vatin: 'OM1100000001',
      }),
    );

    await waitFor(() => {
      expect(screen.getByTestId('loc').textContent).toBe('/firms/firm-new/dashboard');
    });
  });

  it('shows an error when the create call fails', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(makeResponse(500, { error: 'boom' }));

    renderPage();
    await user.type(screen.getByLabelText(/Firm name/i), 'Acme');
    await user.type(screen.getByLabelText(/Legal name/i), 'Acme LLC');
    await user.type(screen.getByLabelText(/CR number/i), 'CR1234');
    await user.type(screen.getByLabelText(/Contact email/i), 'owner@acme.om');
    await user.type(screen.getByLabelText(/Contact phone/i), '+96899123456');
    await user.click(screen.getByRole('button', { name: /create firm/i }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Could not create your firm/i);
  });

  it('omits vatin from payload when field is empty', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (init?.method === 'POST' && url.endsWith('/firms')) {
        return makeResponse(201, { id: 'firm-x', name: 'Acme' });
      }
      return makeResponse(200, []);
    });

    renderPage();
    await user.type(screen.getByLabelText(/Firm name/i), 'Acme');
    await user.type(screen.getByLabelText(/Legal name/i), 'Acme LLC');
    await user.type(screen.getByLabelText(/CR number/i), 'CR1234');
    await user.type(screen.getByLabelText(/Contact email/i), 'owner@acme.om');
    await user.type(screen.getByLabelText(/Contact phone/i), '+96899123456');
    await user.click(screen.getByRole('button', { name: /create firm/i }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const postCall = fetchSpy.mock.calls.find((c) => (c[1] as RequestInit)?.method === 'POST')!;
    const parsed = JSON.parse(postCall[1]?.body as string);
    expect(parsed.vatin).toBeUndefined();
  });
});
