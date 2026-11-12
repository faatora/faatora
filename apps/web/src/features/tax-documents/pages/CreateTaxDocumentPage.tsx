/**
 * Thin page wrapper around TaxDocumentForm.
 *
 * The parent (an invoice-detail page) is expected to pre-load the
 * original invoice and pass it in. That keeps this page agnostic
 * about *where* the invoice came from (a cached list, a dedicated
 * fetch, server-side props), which will matter when the firm console
 * grows a proper invoice-detail route.
 */

import { useTranslation } from 'react-i18next';
import { TaxDocumentForm } from '../components/TaxDocumentForm';
import { createCreditNote, createDebitNote } from '../api';
import type {
  CreateTaxDocumentInput,
  OriginalInvoice,
  TaxDocumentKind,
  TaxDocumentResult,
} from '../types';

export interface CreateTaxDocumentPageProps {
  firmId: string;
  clientId: string;
  kind: TaxDocumentKind;
  invoice: OriginalInvoice;
  onDone?: (result: TaxDocumentResult) => void;
  onCancel?: () => void;
}

export function CreateTaxDocumentPage(props: CreateTaxDocumentPageProps) {
  const { firmId, clientId, kind, invoice, onDone, onCancel } = props;
  const { t } = useTranslation();

  async function submit(input: CreateTaxDocumentInput): Promise<TaxDocumentResult> {
    if (kind === 'credit_note') {
      return createCreditNote(firmId, clientId, input);
    }
    return createDebitNote(firmId, clientId, input);
  }

  if (invoice.status !== 'CLEARED') {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-start text-lg font-semibold text-slate-900">
          {t('taxDocuments.form.notCleared.title')}
        </h2>
        <p className="mt-2 text-start text-sm text-slate-700">
          {t('taxDocuments.form.notCleared.body', { status: invoice.status })}
        </p>
      </div>
    );
  }

  return (
    <TaxDocumentForm
      kind={kind}
      invoice={invoice}
      onSubmit={submit}
      onDone={onDone}
      onCancel={onCancel}
    />
  );
}

/**
 * The "Create credit note" / "Create debit note" button an
 * invoice-detail page renders. Exposed as a stand-alone component so
 * the existing InvoiceDetail flow can drop it in without refactoring.
 */
export interface TaxDocumentCreateButtonProps {
  invoiceStatus: string;
  kind: TaxDocumentKind;
  onClick: () => void;
}

export function TaxDocumentCreateButton(props: TaxDocumentCreateButtonProps) {
  const { t } = useTranslation();
  const disabled = props.invoiceStatus !== 'CLEARED';
  const labelKey =
    props.kind === 'credit_note' ? 'taxDocuments.credit.cta' : 'taxDocuments.debit.cta';
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={disabled}
      title={disabled ? t('taxDocuments.form.notCleared.hint') : undefined}
      className="px-4 py-2 rounded-md bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {t(labelKey)}
    </button>
  );
}
