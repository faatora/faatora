import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import i18n from '../../../i18n';
import { FirmContextProvider } from '../context/FirmContext';
import { FirmMembersPage } from './FirmMembersPage';

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

function renderPage(firmId: string, members: unknown[]) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url.endsWith(`/firms/${firmId}/members`)) {
      return makeResponse(200, members);
    }
    return makeResponse(404, {});
  });

  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={[`/firms/${firmId}/members`]}>
        <FirmContextProvider loadOnMount={false}>
          <Routes>
            <Route path="/firms/:id/members" element={<FirmMembersPage />} />
          </Routes>
        </FirmContextProvider>
      </MemoryRouter>
    </I18nextProvider>,
  );
}

describe('FirmMembersPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the invite button when the viewer is an owner', async () => {
    renderPage('firm-x', [
      { userId: 'u1', email: 'owner@ex.com', role: 'owner', status: 'active', self: true },
      { userId: 'u2', email: 'staff@ex.com', role: 'staff', status: 'invited' },
    ]);
    expect(await screen.findByRole('button', { name: /invite member/i })).toBeInTheDocument();
  });

  it('hides the invite button for read_only viewers', async () => {
    renderPage('firm-x', [
      { userId: 'u1', email: 'ro@ex.com', role: 'read_only', status: 'active', self: true },
    ]);
    await screen.findByText('ro@ex.com');
    expect(screen.queryByRole('button', { name: /invite member/i })).not.toBeInTheDocument();
  });

  it('opens the invite modal and posts the invitation', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.endsWith('/firms/firm-y/members') && (!init || init.method === undefined || init.method === 'GET')) {
        return makeResponse(200, [
          { userId: 'u1', email: 'owner@ex.com', role: 'owner', status: 'active', self: true },
        ]);
      }
      if (init?.method === 'POST' && url.endsWith('/firms/firm-y/members/invites')) {
        return makeResponse(201, { invitationId: 'inv-1' });
      }
      return makeResponse(404, {});
    });

    render(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={['/firms/firm-y/members']}>
          <FirmContextProvider loadOnMount={false}>
            <Routes>
              <Route path="/firms/:id/members" element={<FirmMembersPage />} />
            </Routes>
          </FirmContextProvider>
        </MemoryRouter>
      </I18nextProvider>,
    );

    await screen.findByText('owner@ex.com');
    await user.click(screen.getByRole('button', { name: /invite member/i }));
    await screen.findByRole('dialog');
    await user.type(screen.getByLabelText(/Email/i), 'new@ex.com');
    await user.selectOptions(screen.getByLabelText(/Role/i), 'partner');
    await user.click(screen.getByRole('button', { name: /send invite/i }));

    await waitFor(() => {
      const postCall = fetchSpy.mock.calls.find(
        (c) => (c[1] as RequestInit)?.method === 'POST',
      );
      expect(postCall).toBeDefined();
      const [, init] = postCall!;
      expect(init?.body).toBe(JSON.stringify({ email: 'new@ex.com', role: 'partner' }));
    });
  });
});
