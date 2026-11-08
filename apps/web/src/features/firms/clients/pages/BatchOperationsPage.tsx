// Batch operations page (W2-C).
//
// Two sections:
//   - Validate all pending: POST /firms/:id/operations/validate-all
//   - Export VAT returns: GET /firms/:id/operations/vat-return.csv
//
// Downloading the CSV goes through URL.createObjectURL; the test
// harness stubs apiFetch so no actual network is hit.

import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { validateAll, vatReturnCsv, type ValidationPreviewResult } from '../api/clients';

export interface BatchOperationsPageProps {
  firmId: string;
}

export function BatchOperationsPage(props: BatchOperationsPageProps) {
  const { t } = useTranslation();
  return (
    <div className="mx-auto max-w-4xl">
      <header>
        <h1 className="text-start text-2xl font-bold text-slate-900">{t('ops.title')}</h1>
        <p className="mt-1 text-start text-sm text-slate-600">{t('ops.subtitle')}</p>
      </header>
      <ValidateAllSection firmId={props.firmId} />
      <VatReturnSection firmId={props.firmId} />
    </div>
  );
}

// -------------------- validate-all --------------------

function ValidateAllSection({ firmId }: { firmId: string }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ValidationPreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await validateAll(firmId);
      setResult(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      aria-labelledby="validate-all-heading"
      className="mt-6 rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
    >
      <h2 id="validate-all-heading" className="text-start text-lg font-semibold text-slate-900">
        {t('ops.validateAll.title')}
      </h2>
      <p className="mt-1 text-start text-sm text-slate-600">{t('ops.validateAll.body')}</p>

      <div className="mt-4">
        <button
          type="button"
          onClick={() => void run()}
          disabled={busy}
          className="ps-5 pe-5 py-2 rounded-md bg-indigo-600 text-white font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        >
          {busy ? t('ops.validateAll.running') : t('ops.validateAll.run')}
        </button>
      </div>

      {error && (
        <div
          role="alert"
          className="mt-4 rounded-md border border-rose-200 bg-rose-50 ps-3 pe-3 py-2 text-start text-sm text-rose-900"
        >
          {error}
        </div>
      )}

      {result && (
        <div className="mt-5">
          <p className="text-start text-sm font-medium text-slate-900">
            {t('ops.validateAll.summary', {
              tenants: result.summary.tenantsScanned,
              drafts: result.summary.totalDraft,
              passed: result.summary.totalPassed,
              failed: result.summary.totalFailed,
            })}
          </p>
          <div className="mt-3 overflow-x-auto rounded-md border border-slate-200">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <Th>{t('ops.validateAll.col.tenant')}</Th>
                  <Th>{t('ops.validateAll.col.drafts')}</Th>
                  <Th>{t('ops.validateAll.col.passed')}</Th>
                  <Th>{t('ops.validateAll.col.failed')}</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {result.perTenant.map((p) => (
                  <tr key={p.tenantId}>
                    <Td className="font-medium text-slate-900">{p.tenantName}</Td>
                    <Td className="text-slate-700">{p.totalDraft}</Td>
                    <Td className="text-emerald-800">{p.passed}</Td>
                    <Td className={p.failed > 0 ? 'text-rose-800 font-semibold' : 'text-slate-500'}>
                      {p.failed}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

// -------------------- vat-return.csv --------------------

function VatReturnSection({ firmId }: { firmId: string }) {
  const { t } = useTranslation();
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canDownload = periodStart.length === 10 && periodEnd.length === 10 && !busy;

  const download = useCallback(async () => {
    if (!canDownload) return;
    setBusy(true);
    setError(null);
    try {
      const blob = await vatReturnCsv(firmId, periodStart, periodEnd);
      // The URL.createObjectURL path keeps the file on-device -- the CSV
      // text never touches a server we don't control.
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `vat-return-${periodStart}-to-${periodEnd}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Give the browser a tick to start the download before revoking.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [canDownload, firmId, periodStart, periodEnd]);

  return (
    <section
      aria-labelledby="vat-return-heading"
      className="mt-6 rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
    >
      <h2 id="vat-return-heading" className="text-start text-lg font-semibold text-slate-900">
        {t('ops.vatReturn.title')}
      </h2>
      <p className="mt-1 text-start text-sm text-slate-600">{t('ops.vatReturn.body')}</p>

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block text-start">
          <span className="text-sm font-medium text-slate-800">
            {t('ops.vatReturn.periodStart')}
          </span>
          <input
            type="date"
            value={periodStart}
            onChange={(e) => setPeriodStart(e.target.value)}
            className="mt-1 w-full rounded-md border border-slate-300 bg-white ps-3 pe-3 py-2 text-start text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          />
        </label>
        <label className="block text-start">
          <span className="text-sm font-medium text-slate-800">{t('ops.vatReturn.periodEnd')}</span>
          <input
            type="date"
            value={periodEnd}
            onChange={(e) => setPeriodEnd(e.target.value)}
            className="mt-1 w-full rounded-md border border-slate-300 bg-white ps-3 pe-3 py-2 text-start text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          />
        </label>
      </div>

      {error && (
        <div
          role="alert"
          className="mt-4 rounded-md border border-rose-200 bg-rose-50 ps-3 pe-3 py-2 text-start text-sm text-rose-900"
        >
          {error}
        </div>
      )}

      <div className="mt-4">
        <button
          type="button"
          onClick={() => void download()}
          disabled={!canDownload}
          className="ps-5 pe-5 py-2 rounded-md bg-indigo-600 text-white font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        >
          {busy ? t('ops.vatReturn.downloading') : t('ops.vatReturn.download')}
        </button>
      </div>
    </section>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th
      scope="col"
      className="ps-3 pe-3 py-2 text-start text-xs font-semibold uppercase tracking-wide text-slate-600"
    >
      {children}
    </th>
  );
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={`ps-3 pe-3 py-2 text-start ${className ?? ''}`}>{children}</td>;
}

export default BatchOperationsPage;
