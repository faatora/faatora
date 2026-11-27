import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import i18n from '../../i18n';
import { PosLoginPage } from './LoginPage';
import { ACCESS_TOKEN_STORAGE_KEY, ACTIVE_TENANT_STORAGE_KEY } from '../../lib/api';

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

function renderLoginPage() {
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={['/pos/login']}>
        <Routes>
          <Route path="/pos/login" element={<PosLoginPage />} />
          <Route path="/pos" element={<LocationReporter />} />
          <Route path="*" element={<LocationReporter />} />
        </Routes>
      </MemoryRouter>
    </I18nextProvider>,
  );
}

describe('PosLoginPage', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders the email and password fields and a disabled submit button', () => {
    renderLoginPage();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in/i })).toBeDisabled();
  });

  it('enables submit once both fields are filled', async () => {
    const user = userEvent.setup();
    renderLoginPage();
    await user.type(screen.getByLabelText(/email/i), 'cashier@shop.om');
    await user.type(screen.getByLabelText(/password/i), 'hunter2');
    expect(screen.getByRole('button', { name: /sign in/i })).toBeEnabled();
  });

  it('POSTs credentials to /auth/login, stores the token, and routes to /pos on success', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (init?.method === 'POST' && url.endsWith('/auth/login')) {
        return makeResponse(200, {
          accessToken: 'tok-123',
          tenantId: 'shop-1',
          expiresIn: 3600,
        });
      }
      return makeResponse(404, {});
    });

    renderLoginPage();
    await user.type(screen.getByLabelText(/email/i), 'cashier@shop.om');
    await user.type(screen.getByLabelText(/password/i), 'hunter2');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const [, init] = fetchSpy.mock.calls[0];
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ email: 'cashier@shop.om', password: 'hunter2' }));
    await waitFor(() => expect(localStorage.getItem(ACCESS_TOKEN_STORAGE_KEY)).toBe('tok-123'));
    expect(localStorage.getItem(ACTIVE_TENANT_STORAGE_KEY)).toBe('shop-1');
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/pos'));
  });

  it('shows a credentials error on 401 and keeps the form filled', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeResponse(401, { error: 'bad credentials' }),
    );

    renderLoginPage();
    await user.type(screen.getByLabelText(/email/i), 'cashier@shop.om');
    await user.type(screen.getByLabelText(/password/i), 'wrong');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/don't match/i);
    // Fields preserved so the clerk can retype the password.
    expect((screen.getByLabelText(/email/i) as HTMLInputElement).value).toBe('cashier@shop.om');
    expect((screen.getByLabelText(/password/i) as HTMLInputElement).value).toBe('wrong');
    expect(localStorage.getItem(ACCESS_TOKEN_STORAGE_KEY)).toBeNull();
  });
});
