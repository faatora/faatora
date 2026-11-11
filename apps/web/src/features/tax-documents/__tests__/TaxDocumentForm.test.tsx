/**
 * Smoke test for the credit / debit note form.
 *
 * Renders the form against a CLEARED invoice fixture, confirms the
 * live totals reflect line selection, and verifies the submit path
 * carries the right payload to the injected submitter.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import i18n from '../../../i18n';
import { TaxDocumentForm } from '../components/TaxDocumentForm';
import { CreateTaxDocumentPage, TaxDocumentCreateButton } from '../pages/CreateTaxDocumentPage';
import type { OriginalInvoice, TaxDocumentResult } from '../types';

function invoiceFixture(overrides: Partial<OriginalInvoice> = {}): OriginalInvoice {
  return {
    id: 'inv-1',
    number: 'INV-0001',
    issueDate: '2026-10-01',
    status: 'CLEARED',
    currency: 'OMR',
    lines: [
      {
        id: 'line-1',
        lineNo: 1,
        description: 'Widget',
        quantity: 2,
        unitCode: 'C62',
        unitPrice: 10,
        vatCategory: 'S',
        vatRate: 5,
      },
      {
        id: 'line-2',
        lineNo: 2,
        description: 'Gadget',
        quantity: 1,
        unitCode: 'C62',
        unitPrice: 30,
        vatCategory: 'S',
        vatRate: 5,
      },
    ],
    ...overrides,
  };
}

function okResult(): TaxDocumentResult {
  return {
    id: 'cn-1',
    kind: 'credit_note',
    number: 'CN-0001',
    originalInvoiceId: 'inv-1',
    status: 'VALIDATED',
    currency: 'OMR',
    subtotal: '50.000',
    vatTotal: '2.500',
    grandTotal: '52.500',
    ublXml: '<?xml version="1.0"?><CreditNote/>',
    rulePackVersion: '0.1.0-pint-om',
    lines: [],
  };
}

function wrap(node: React.ReactNode) {
  return <I18nextProvider i18n={i18n}>{node}</I18nextProvider>;
}

describe('TaxDocumentForm', () => {
  it('renders a row per invoice line and shows a live total', () => {
    const onSubmit = vi.fn();
    render(
      wrap(<TaxDocumentForm kind="credit_note" invoice={invoiceFixture()} onSubmit={onSubmit} />),
    );
    expect(screen.getByText('Widget')).toBeInTheDocument();
    expect(screen.getByText('Gadget')).toBeInTheDocument();
    // Totals: both lines selected at full qty => 20 + 30 = 50 + 5% VAT = 52.500
    expect(screen.getByText('52.500')).toBeInTheDocument();
  });

  it('updates the live total when a line is unchecked', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      wrap(<TaxDocumentForm kind="credit_note" invoice={invoiceFixture()} onSubmit={onSubmit} />),
    );

    const [firstCheckbox] = screen.getAllByRole('checkbox');
    await user.click(firstCheckbox); // deselect Widget (20.000)
    // 30 + 5% VAT = 31.500 left.
    await waitFor(() => expect(screen.getByText('31.500')).toBeInTheDocument());
  });

  it('submits selected lines with their quantities to the injected handler', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(okResult());
    const onDone = vi.fn();
    render(
      wrap(
        <TaxDocumentForm
          kind="credit_note"
          invoice={invoiceFixture()}
          onSubmit={onSubmit}
          onDone={onDone}
        />,
      ),
    );

    await user.click(screen.getByRole('button', { name: /Issue credit note/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.originalInvoiceId).toBe('inv-1');
    expect(payload.lines).toHaveLength(2);
    expect(payload.lines[0]).toMatchObject({
      description: 'Widget',
      quantity: 2,
      unitPrice: 10,
      vatRate: 5,
      originalInvoiceLineId: 'line-1',
    });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('blocks submit when every line is unchecked', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      wrap(<TaxDocumentForm kind="credit_note" invoice={invoiceFixture()} onSubmit={onSubmit} />),
    );

    for (const cb of screen.getAllByRole('checkbox')) {
      await user.click(cb);
    }
    await user.click(screen.getByRole('button', { name: /Issue credit note/i }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('shows a debit-note heading and submit label when kind=debit_note', () => {
    const onSubmit = vi.fn();
    render(
      wrap(<TaxDocumentForm kind="debit_note" invoice={invoiceFixture()} onSubmit={onSubmit} />),
    );
    expect(
      screen.getByRole('heading', { name: /create debit note/i, level: 2 }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /issue debit note/i })).toBeInTheDocument();
  });
});

describe('CreateTaxDocumentPage', () => {
  it('refuses to render the form when the invoice is not cleared', () => {
    const onSubmit = vi.fn();
    render(
      wrap(
        <CreateTaxDocumentPage
          firmId="firm-x"
          clientId="client-y"
          kind="credit_note"
          invoice={invoiceFixture({ status: 'DRAFT' })}
        />,
      ),
    );
    expect(screen.getByText(/cannot be adjusted yet/i)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('TaxDocumentCreateButton', () => {
  it('is enabled only when the invoice is cleared', () => {
    const onClick = vi.fn();
    const { rerender } = render(
      wrap(<TaxDocumentCreateButton kind="credit_note" invoiceStatus="DRAFT" onClick={onClick} />),
    );
    expect(screen.getByRole('button')).toBeDisabled();

    rerender(
      wrap(
        <TaxDocumentCreateButton kind="credit_note" invoiceStatus="CLEARED" onClick={onClick} />,
      ),
    );
    expect(screen.getByRole('button')).toBeEnabled();
  });
});
