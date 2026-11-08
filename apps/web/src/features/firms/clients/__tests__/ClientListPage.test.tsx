/**
 * EP5 Wave 2 (W2-C) -- client list page tests.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import i18n from '../../../../i18n';
import { ClientListPage } from '../pages/ClientListPage';

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

afterEach(() => vi.restoreAllMocks());

describe('ClientListPage', () => {
  it('renders the fetched clients with name and engagement type', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
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

    render(
      <I18nextProvider i18n={i18n}>
        <ClientListPage firmId="firm-1" />
      </I18nextProvider>,
    );

    expect(await screen.findByText('Alpha Co')).toBeInTheDocument();
    expect(screen.getByText('Beta Co')).toBeInTheDocument();
  });

  it('filters by engagement type', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
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
    render(
      <I18nextProvider i18n={i18n}>
        <ClientListPage firmId="firm-1" />
      </I18nextProvider>,
    );
    await screen.findByText('Alpha Co');
    const engagementSelect = screen.getByLabelText(/engagement/i);
    await user.selectOptions(engagementSelect, 'periodic');
    await waitFor(() => expect(screen.queryByText('Alpha Co')).not.toBeInTheDocument());
    expect(screen.getByText('Beta Co')).toBeInTheDocument();
  });

  it('calls onAddClient when the Add button is clicked', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => makeResponse(200, []));
    const onAdd = vi.fn();
    const user = userEvent.setup();
    render(
      <I18nextProvider i18n={i18n}>
        <ClientListPage firmId="firm-1" onAddClient={onAdd} />
      </I18nextProvider>,
    );
    await screen.findByText(/no clients yet/i);
    await user.click(screen.getByRole('button', { name: /add client/i }));
    expect(onAdd).toHaveBeenCalled();
  });
});
