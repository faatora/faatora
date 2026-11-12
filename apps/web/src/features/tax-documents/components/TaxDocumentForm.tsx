/**
 * Shared form component for credit and debit notes.
 *
 * Takes the original cleared invoice and renders:
 *   - a per-line checkbox + editable quantity so the user can choose
 *     "credit this line", "credit partial quantity", or leave it out.
 *   - a document number, issue date, and optional reason field.
 *   - a live totals summary that reuses the same OMR-baisa math shape
 *     the server uses (quantity * unitPrice, 5% VAT per selected line).
 *
 * On submit, it POSTs via the injected submitter (createCreditNote or
 * createDebitNote). The caller controls which variant is active via
 * the `kind` prop so both the title and the button label follow i18n.
 */

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  CreateTaxDocumentInput,
  OriginalInvoice,
  TaxDocumentKind,
  TaxDocumentResult,
} from '../types';

export interface TaxDocumentFormProps {
  kind: TaxDocumentKind;
  invoice: OriginalInvoice;
  onSubmit: (input: CreateTaxDocumentInput) => Promise<TaxDocumentResult>;
  onDone?: (result: TaxDocumentResult) => void;
  onCancel?: () => void;
}

interface LineState {
  selected: boolean;
  quantity: number;
  originalInvoiceLineId: string;
  description: string;
  unitCode: string;
  unitPrice: number;
  vatCategory: string;
  vatRate: number;
}

function todayIso(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function amountScale(currency: string): number {
  return currency === 'OMR' ? 3 : 2;
}

function fmt(value: number, currency: string): string {
  return value.toFixed(amountScale(currency));
}

export function TaxDocumentForm(props: TaxDocumentFormProps) {
  const { t } = useTranslation();
  const { kind, invoice, onSubmit, onDone, onCancel } = props;

  // One row of local state per original invoice line. Initially every
  // line is selected at its full quantity — the common case for a
  // full-invoice reversal is the fast path.
  const [lineStates, setLineStates] = useState<LineState[]>(() =>
    invoice.lines.map((l) => ({
      selected: true,
      quantity: l.quantity,
      originalInvoiceLineId: l.id,
      description: l.description,
      unitCode: l.unitCode,
      unitPrice: l.unitPrice,
      vatCategory: l.vatCategory,
      vatRate: l.vatRate,
    })),
  );
  const [number, setNumber] = useState<string>(
    () => `${kind === 'credit_note' ? 'CN' : 'DN'}-${Date.now()}`,
  );
  const [issueDate, setIssueDate] = useState<string>(todayIso());
  const [reason, setReason] = useState<string>('');
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const totals = useMemo(() => {
    let subtotal = 0;
    let vat = 0;
    for (const l of lineStates) {
      if (!l.selected) continue;
      const net = l.quantity * l.unitPrice;
      subtotal += net;
      vat += (net * l.vatRate) / 100;
    }
    return {
      subtotal,
      vat,
      grand: subtotal + vat,
    };
  }, [lineStates]);

  function toggleLine(idx: number): void {
    setLineStates((prev) => prev.map((l, i) => (i === idx ? { ...l, selected: !l.selected } : l)));
  }

  function updateQuantity(idx: number, q: number): void {
    setLineStates((prev) => prev.map((l, i) => (i === idx ? { ...l, quantity: q } : l)));
  }

  async function handleSubmit(ev: React.FormEvent) {
    ev.preventDefault();
    setError(null);
    const selected = lineStates.filter((l) => l.selected && l.quantity > 0);
    if (selected.length === 0) {
      setError(t('taxDocuments.form.errors.noLines'));
      return;
    }
    setBusy(true);
    try {
      const result = await onSubmit({
        number,
        issueDate,
        originalInvoiceId: invoice.id,
        currency: invoice.currency,
        reason: reason || undefined,
        lines: selected.map((l) => ({
          description: l.description,
          quantity: l.quantity,
          unitCode: l.unitCode,
          unitPrice: l.unitPrice,
          vatCategory: l.vatCategory,
          vatRate: l.vatRate,
          originalInvoiceLineId: l.originalInvoiceLineId,
        })),
      });
      onDone?.(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const titleKey =
    kind === 'credit_note' ? 'taxDocuments.credit.title' : 'taxDocuments.debit.title';
  const submitKey =
    kind === 'credit_note' ? 'taxDocuments.credit.submit' : 'taxDocuments.debit.submit';

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm space-y-6"
      aria-labelledby="tax-doc-form-title"
    >
      <header>
        <h2 id="tax-doc-form-title" className="text-start text-xl font-semibold text-slate-900">
          {t(titleKey)}
        </h2>
        <p className="mt-1 text-start text-sm text-slate-600">
          {t('taxDocuments.form.againstInvoice', { number: invoice.number })}
        </p>
      </header>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="block text-start text-sm">
          <span className="font-medium text-slate-700">{t('taxDocuments.form.number')}</span>
          <input
            type="text"
            required
            value={number}
            onChange={(e) => setNumber(e.target.value)}
            className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2"
          />
        </label>
        <label className="block text-start text-sm">
          <span className="font-medium text-slate-700">{t('taxDocuments.form.issueDate')}</span>
          <input
            type="date"
            required
            value={issueDate}
            onChange={(e) => setIssueDate(e.target.value)}
            className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2"
          />
        </label>
      </div>

      <label className="block text-start text-sm">
        <span className="font-medium text-slate-700">{t('taxDocuments.form.reason')}</span>
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t('taxDocuments.form.reasonPlaceholder')}
          className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2"
        />
      </label>

      <section aria-label={t('taxDocuments.form.linesSection')}>
        <h3 className="text-start text-base font-semibold text-slate-900">
          {t('taxDocuments.form.linesTitle')}
        </h3>
        <table className="mt-3 w-full text-start text-sm">
          <thead className="text-start text-xs uppercase text-slate-500">
            <tr>
              <th className="py-2 px-2 text-start" scope="col">
                {t('taxDocuments.form.col.pick')}
              </th>
              <th className="py-2 px-2 text-start" scope="col">
                {t('taxDocuments.form.col.description')}
              </th>
              <th className="py-2 px-2 text-end" scope="col">
                {t('taxDocuments.form.col.qty')}
              </th>
              <th className="py-2 px-2 text-end" scope="col">
                {t('taxDocuments.form.col.unitPrice')}
              </th>
              <th className="py-2 px-2 text-end" scope="col">
                {t('taxDocuments.form.col.lineNet')}
              </th>
            </tr>
          </thead>
          <tbody>
            {lineStates.map((l, i) => {
              const net = l.quantity * l.unitPrice;
              return (
                <tr key={l.originalInvoiceLineId} className="border-t border-slate-100">
                  <td className="py-2 px-2">
                    <input
                      type="checkbox"
                      checked={l.selected}
                      onChange={() => toggleLine(i)}
                      aria-label={t('taxDocuments.form.lineAria', { description: l.description })}
                    />
                  </td>
                  <td className="py-2 px-2 text-start">{l.description}</td>
                  <td className="py-2 px-2 text-end">
                    <input
                      type="number"
                      min={0}
                      step={0.001}
                      max={invoice.lines[i]?.quantity ?? l.quantity}
                      value={l.quantity}
                      onChange={(e) => updateQuantity(i, Number(e.target.value))}
                      disabled={!l.selected}
                      className="w-20 rounded-md border border-slate-300 px-2 py-1 text-end"
                    />
                  </td>
                  <td className="py-2 px-2 text-end tabular-nums">
                    {fmt(l.unitPrice, invoice.currency)}
                  </td>
                  <td className="py-2 px-2 text-end tabular-nums">
                    {l.selected ? fmt(net, invoice.currency) : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <aside
        aria-label={t('taxDocuments.form.totalsAria')}
        className="rounded-lg bg-slate-50 p-4 text-sm"
      >
        <div className="flex items-center justify-between">
          <span>{t('taxDocuments.form.subtotal')}</span>
          <span className="tabular-nums">{fmt(totals.subtotal, invoice.currency)}</span>
        </div>
        <div className="mt-1 flex items-center justify-between">
          <span>{t('taxDocuments.form.vat')}</span>
          <span className="tabular-nums">{fmt(totals.vat, invoice.currency)}</span>
        </div>
        <div className="mt-2 flex items-center justify-between border-t border-slate-200 pt-2 font-semibold">
          <span>{t('taxDocuments.form.grandTotal')}</span>
          <span className="tabular-nums">{fmt(totals.grand, invoice.currency)}</span>
        </div>
      </aside>

      {error && (
        <div role="alert" className="rounded-md bg-rose-50 p-3 text-sm text-rose-800">
          {error}
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="px-4 py-2 rounded-md text-sm font-medium text-slate-700 hover:bg-slate-100"
          >
            {t('taxDocuments.form.cancel')}
          </button>
        )}
        <button
          type="submit"
          disabled={busy}
          className="px-4 py-2 rounded-md bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
        >
          {busy ? t('taxDocuments.form.submitting') : t(submitKey)}
        </button>
      </div>
    </form>
  );
}
