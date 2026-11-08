/**
 * W2-D — Tally / Zoho Books import wizard.
 *
 * Five steps:
 *   1. Pick source format (Tally Day Book / Tally Sales Register / Tally XML / Zoho Books CSV)
 *   2. Pick target client tenant (from the firm's clients list)
 *   3. Upload file — server returns preview
 *   4. Review preview + edit column mapping inline
 *   5. Commit + show final summary
 *
 * All strings pulled from the i18n bundle so the wizard is bilingual and
 * RTL-correct. The DirectionProvider wrapping the app sets `dir` globally;
 * the layout here relies on logical properties (`ms-*`, `me-*`, `text-start`)
 * so no explicit mirror logic is needed inside the wizard.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router-dom';
import { ApiError } from '../../../lib/api';
import { listFirmClients } from '../../firms/api';
import { useFirmContext } from '../../firms/context/FirmContext';
import type { FirmClientTenant } from '../../firms/types';
import {
  commitImport,
  previewImport,
  saveColumnMapping,
} from '../api';
import {
  IMPORT_SOURCE_FORMATS,
  type ColumnMapping,
  type CommitResponse,
  type ImportSourceFormat,
  type PreviewResponse,
} from '../types';

type WizardStep = 'format' | 'tenant' | 'upload' | 'review' | 'done';

const CANONICAL_FIELDS: Array<keyof ColumnMapping> = [
  'invoiceNumber',
  'invoiceDate',
  'buyerName',
  'buyerVatin',
  'supplierName',
  'supplierVatin',
  'taxableAmount',
  'vatAmount',
  'totalAmount',
  'description',
];

export function ImportWizardPage() {
  const { t } = useTranslation();
  const { id: firmIdParam } = useParams();
  const { activeFirm, switchFirm } = useFirmContext();
  const firmId = firmIdParam ?? activeFirm?.id ?? '';

  useEffect(() => {
    if (!firmIdParam) return;
    if (activeFirm?.id === firmIdParam) return;
    switchFirm(firmIdParam);
  }, [firmIdParam, activeFirm?.id, switchFirm]);

  const [step, setStep] = useState<WizardStep>('format');
  const [sourceFormat, setSourceFormat] = useState<ImportSourceFormat | null>(null);
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [clients, setClients] = useState<FirmClientTenant[]>([]);
  const [clientsError, setClientsError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [editedMapping, setEditedMapping] = useState<boolean>(false);
  const [saveMappingFlag, setSaveMappingFlag] = useState<boolean>(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [filename, setFilename] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [commitResult, setCommitResult] = useState<CommitResponse | null>(null);
  const [commitError, setCommitError] = useState<string | null>(null);

  useEffect(() => {
    if (!firmId) return;
    listFirmClients(firmId)
      .then(setClients)
      .catch(() => setClientsError(t('imports.wizard.clients_error')));
  }, [firmId, t]);

  const goBack = () => {
    if (step === 'tenant') setStep('format');
    else if (step === 'upload') setStep('tenant');
    else if (step === 'review') setStep('upload');
    else if (step === 'done') setStep('review');
  };

  const onFile = useCallback(
    async (ev: ChangeEvent<HTMLInputElement>) => {
      const file = ev.target.files?.[0];
      if (!file || !firmId || !tenantId || !sourceFormat) return;
      setBusy(true);
      setUploadError(null);
      setFilename(file.name);
      try {
        const resp = await previewImport(firmId, tenantId, sourceFormat, file, file.name);
        setPreview(resp);
        setMapping(resp.mapping);
        setEditedMapping(false);
        setStep('review');
      } catch (err) {
        const message =
          err instanceof ApiError
            ? (err.body as { message?: string })?.message ?? err.message
            : (err as Error).message;
        setUploadError(message);
      } finally {
        setBusy(false);
      }
    },
    [firmId, tenantId, sourceFormat],
  );

  const onMappingChange = (field: string, column: string) => {
    setMapping((m) => ({ ...m, [field]: column || undefined }));
    setEditedMapping(true);
  };

  const commit = async () => {
    if (!preview || !firmId) return;
    setBusy(true);
    setCommitError(null);
    try {
      // If the mapping was edited and the firm checked "save mapping",
      // also persist it as the new default for this format.
      if (editedMapping && saveMappingFlag && sourceFormat) {
        await saveColumnMapping(firmId, sourceFormat, mapping);
      }
      const resp = await commitImport(
        firmId,
        preview.previewToken,
        editedMapping ? mapping : undefined,
        false,
      );
      setCommitResult(resp);
      setStep('done');
    } catch (err) {
      const message =
        err instanceof ApiError
          ? (err.body as { message?: string })?.message ?? err.message
          : (err as Error).message;
      setCommitError(message);
    } finally {
      setBusy(false);
    }
  };

  const errorsByRow = useMemo(() => {
    const map = new Map<number, string[]>();
    for (const e of preview?.errors ?? []) {
      const list = map.get(e.sourceRowNo) ?? [];
      list.push(e.message);
      map.set(e.sourceRowNo, list);
    }
    return map;
  }, [preview]);

  return (
    <section
      className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
      data-testid="import-wizard"
    >
      <h1 className="text-start text-xl font-semibold text-slate-900">
        {t('imports.wizard.title')}
      </h1>
      <p className="mt-2 text-start text-sm text-slate-700">{t('imports.wizard.subtitle')}</p>

      <ol
        aria-label={t('imports.wizard.steps_aria')}
        className="mt-4 flex items-center gap-2 text-xs text-slate-500"
      >
        {(['format', 'tenant', 'upload', 'review', 'done'] as WizardStep[]).map((s, i) => {
          const isActive = s === step;
          const isDone =
            (['format', 'tenant', 'upload', 'review', 'done'] as WizardStep[]).indexOf(step) > i;
          return (
            <li
              key={s}
              className={[
                'ps-2 pe-2 py-1 rounded-md',
                isActive
                  ? 'bg-indigo-100 text-indigo-800 font-medium'
                  : isDone
                    ? 'bg-slate-100 text-slate-700'
                    : 'text-slate-400',
              ].join(' ')}
            >
              {t(`imports.wizard.step.${s}`)}
            </li>
          );
        })}
      </ol>

      {step === 'format' && (
        <div className="mt-6 space-y-3" data-testid="step-format">
          <h2 className="text-start text-base font-semibold text-slate-900">
            {t('imports.wizard.format.title')}
          </h2>
          <div className="grid gap-2">
            {IMPORT_SOURCE_FORMATS.map((f) => (
              <label
                key={f}
                className="flex items-center gap-3 rounded-md border border-slate-200 ps-3 pe-3 py-2 cursor-pointer hover:bg-slate-50"
              >
                <input
                  type="radio"
                  name="sourceFormat"
                  value={f}
                  checked={sourceFormat === f}
                  onChange={() => setSourceFormat(f)}
                  data-testid={`format-${f}`}
                />
                <span className="text-sm text-slate-800">{t(`imports.wizard.format.${f}`)}</span>
              </label>
            ))}
          </div>
          <div className="mt-4 flex justify-end">
            <button
              type="button"
              disabled={!sourceFormat}
              onClick={() => setStep('tenant')}
              className="ps-4 pe-4 py-2 rounded-md bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
              data-testid="next-to-tenant"
            >
              {t('imports.wizard.next')}
            </button>
          </div>
        </div>
      )}

      {step === 'tenant' && (
        <div className="mt-6 space-y-3" data-testid="step-tenant">
          <h2 className="text-start text-base font-semibold text-slate-900">
            {t('imports.wizard.tenant.title')}
          </h2>
          {clientsError && (
            <p className="text-sm text-red-700" role="alert">
              {clientsError}
            </p>
          )}
          {clients.length === 0 && !clientsError && (
            <p className="text-sm text-slate-600">{t('imports.wizard.tenant.empty')}</p>
          )}
          <ul className="grid gap-2">
            {clients.map((c) => (
              <li key={c.tenantId}>
                <label className="flex items-center gap-3 rounded-md border border-slate-200 ps-3 pe-3 py-2 cursor-pointer hover:bg-slate-50">
                  <input
                    type="radio"
                    name="tenantId"
                    value={c.tenantId}
                    checked={tenantId === c.tenantId}
                    onChange={() => setTenantId(c.tenantId)}
                    data-testid={`tenant-${c.tenantId}`}
                  />
                  <span className="text-sm text-slate-800">{c.tenantName}</span>
                </label>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex justify-between gap-2">
            <button
              type="button"
              onClick={goBack}
              className="ps-4 pe-4 py-2 rounded-md border border-slate-300 text-slate-700 text-sm font-medium hover:bg-slate-50"
            >
              {t('imports.wizard.back')}
            </button>
            <button
              type="button"
              disabled={!tenantId}
              onClick={() => setStep('upload')}
              className="ps-4 pe-4 py-2 rounded-md bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
              data-testid="next-to-upload"
            >
              {t('imports.wizard.next')}
            </button>
          </div>
        </div>
      )}

      {step === 'upload' && (
        <div className="mt-6 space-y-3" data-testid="step-upload">
          <h2 className="text-start text-base font-semibold text-slate-900">
            {t('imports.wizard.upload.title')}
          </h2>
          <p className="text-sm text-slate-600">{t('imports.wizard.upload.subtitle')}</p>
          <input
            type="file"
            accept=".csv,.xml,text/csv,text/xml,application/xml"
            onChange={onFile}
            disabled={busy}
            data-testid="file-input"
            className="block"
          />
          {busy && (
            <p role="status" className="text-sm text-slate-600">
              {t('imports.wizard.upload.busy')}
            </p>
          )}
          {uploadError && (
            <p role="alert" className="text-sm text-red-700" data-testid="upload-error">
              {uploadError}
            </p>
          )}
          <div className="mt-4 flex justify-between">
            <button
              type="button"
              onClick={goBack}
              className="ps-4 pe-4 py-2 rounded-md border border-slate-300 text-slate-700 text-sm font-medium hover:bg-slate-50"
            >
              {t('imports.wizard.back')}
            </button>
          </div>
        </div>
      )}

      {step === 'review' && preview && (
        <div className="mt-6 space-y-4" data-testid="step-review">
          <h2 className="text-start text-base font-semibold text-slate-900">
            {t('imports.wizard.review.title')}
          </h2>
          <div
            className="grid grid-cols-2 gap-2 sm:grid-cols-4 text-sm"
            data-testid="preview-summary"
          >
            <SummaryCard
              label={t('imports.wizard.summary.total')}
              value={preview.summary.totalRows}
            />
            <SummaryCard
              label={t('imports.wizard.summary.valid')}
              value={preview.summary.validRows}
              tone="green"
            />
            <SummaryCard
              label={t('imports.wizard.summary.error')}
              value={preview.summary.errorRows}
              tone={preview.summary.errorRows > 0 ? 'red' : 'default'}
            />
            <SummaryCard
              label={t('imports.wizard.summary.duplicate')}
              value={preview.summary.duplicateRows}
              tone={preview.summary.duplicateRows > 0 ? 'amber' : 'default'}
            />
          </div>

          <details className="rounded-md border border-slate-200 p-3" data-testid="mapping-editor">
            <summary className="text-start text-sm font-medium cursor-pointer">
              {t('imports.wizard.mapping.title')}
            </summary>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {CANONICAL_FIELDS.map((f) => (
                <label key={f} className="flex flex-col gap-1 text-xs">
                  <span className="text-slate-600">{f}</span>
                  <select
                    value={mapping[f] ?? ''}
                    onChange={(ev) => onMappingChange(f, ev.target.value)}
                    className="rounded-md border border-slate-300 ps-2 pe-2 py-1 text-sm"
                    data-testid={`mapping-${f}`}
                  >
                    <option value="">{t('imports.wizard.mapping.unset')}</option>
                    {preview.headers.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            <label className="mt-3 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={saveMappingFlag}
                onChange={(ev) => setSaveMappingFlag(ev.target.checked)}
                data-testid="save-mapping"
              />
              <span>{t('imports.wizard.mapping.save')}</span>
            </label>
          </details>

          <PreviewTable rows={preview.rows} errorsByRow={errorsByRow} />
          {preview.errors.length > 0 && (
            <div
              className="rounded-md border border-red-200 bg-red-50 p-3"
              data-testid="error-list"
            >
              <h3 className="text-start text-sm font-medium text-red-800">
                {t('imports.wizard.errors.title')}
              </h3>
              <ul className="mt-2 list-disc ps-6 pe-6 space-y-1 text-xs text-red-900">
                {preview.errors.map((e, i) => (
                  <li key={i}>{e.message}</li>
                ))}
              </ul>
            </div>
          )}
          {commitError && (
            <p role="alert" className="text-sm text-red-700" data-testid="commit-error">
              {commitError}
            </p>
          )}
          <div className="mt-4 flex justify-between gap-2">
            <button
              type="button"
              onClick={goBack}
              className="ps-4 pe-4 py-2 rounded-md border border-slate-300 text-slate-700 text-sm font-medium hover:bg-slate-50"
            >
              {t('imports.wizard.back')}
            </button>
            <button
              type="button"
              onClick={commit}
              disabled={busy || preview.summary.validRows === 0}
              className="ps-4 pe-4 py-2 rounded-md bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
              data-testid="commit-button"
            >
              {t('imports.wizard.commit')}
            </button>
          </div>
        </div>
      )}

      {step === 'done' && commitResult && (
        <div className="mt-6 space-y-3" data-testid="step-done">
          <h2 className="text-start text-base font-semibold text-slate-900">
            {t('imports.wizard.done.title')}
          </h2>
          <ul className="list-disc ps-6 pe-6 space-y-1 text-sm text-slate-800">
            <li>
              {t('imports.wizard.done.committed', { n: commitResult.rowCountCommitted })}
            </li>
            <li>{t('imports.wizard.done.skipped', { n: commitResult.rowCountSkipped })}</li>
            <li>{t('imports.wizard.done.errored', { n: commitResult.rowCountErrored })}</li>
          </ul>
          <p className="text-xs text-slate-500">
            {t('imports.wizard.done.filename', { name: filename ?? '' })}
          </p>
        </div>
      )}
    </section>
  );
}

function SummaryCard({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: number;
  tone?: 'default' | 'green' | 'red' | 'amber';
}) {
  const toneClasses =
    tone === 'green'
      ? 'bg-green-50 text-green-800 border-green-200'
      : tone === 'red'
        ? 'bg-red-50 text-red-800 border-red-200'
        : tone === 'amber'
          ? 'bg-amber-50 text-amber-800 border-amber-200'
          : 'bg-slate-50 text-slate-700 border-slate-200';
  return (
    <div className={`rounded-md border ${toneClasses} ps-3 pe-3 py-2`}>
      <div className="text-xs">{label}</div>
      <div className="text-start text-lg font-semibold">{value}</div>
    </div>
  );
}

function PreviewTable({
  rows,
  errorsByRow,
}: {
  rows: PreviewResponse['rows'];
  errorsByRow: Map<number, string[]>;
}) {
  const { t } = useTranslation();
  if (rows.length === 0 && errorsByRow.size === 0) {
    return <p className="text-sm text-slate-600">{t('imports.wizard.review.empty')}</p>;
  }
  return (
    <div className="overflow-x-auto rounded-md border border-slate-200">
      <table className="w-full text-xs">
        <thead className="bg-slate-50">
          <tr>
            <th className="ps-2 pe-2 py-1 text-start">#</th>
            <th className="ps-2 pe-2 py-1 text-start">
              {t('imports.wizard.review.col.number')}
            </th>
            <th className="ps-2 pe-2 py-1 text-start">
              {t('imports.wizard.review.col.date')}
            </th>
            <th className="ps-2 pe-2 py-1 text-start">
              {t('imports.wizard.review.col.party')}
            </th>
            <th className="ps-2 pe-2 py-1 text-start">
              {t('imports.wizard.review.col.taxable')}
            </th>
            <th className="ps-2 pe-2 py-1 text-start">
              {t('imports.wizard.review.col.vat')}
            </th>
            <th className="ps-2 pe-2 py-1 text-start">
              {t('imports.wizard.review.col.total')}
            </th>
            <th className="ps-2 pe-2 py-1 text-start">
              {t('imports.wizard.review.col.status')}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.rowHash}
              className={r.duplicate ? 'bg-amber-50' : 'odd:bg-white even:bg-slate-50'}
              data-testid={`preview-row-${r.sourceRowNo}`}
            >
              <td className="ps-2 pe-2 py-1">{r.sourceRowNo}</td>
              <td className="ps-2 pe-2 py-1">{r.invoiceNumber}</td>
              <td className="ps-2 pe-2 py-1">{r.invoiceDate}</td>
              <td className="ps-2 pe-2 py-1">{r.buyerName ?? r.supplierName ?? ''}</td>
              <td className="ps-2 pe-2 py-1">{r.taxableAmount.toFixed(3)}</td>
              <td className="ps-2 pe-2 py-1">{r.vatAmount.toFixed(3)}</td>
              <td className="ps-2 pe-2 py-1">{r.totalAmount.toFixed(3)}</td>
              <td className="ps-2 pe-2 py-1">
                {r.duplicate
                  ? t('imports.wizard.review.status.duplicate')
                  : t('imports.wizard.review.status.ok')}
              </td>
            </tr>
          ))}
          {Array.from(errorsByRow.entries()).map(([rowNo, msgs]) => (
            <tr key={`err-${rowNo}`} className="bg-red-50" data-testid={`error-row-${rowNo}`}>
              <td className="ps-2 pe-2 py-1">{rowNo}</td>
              <td className="ps-2 pe-2 py-1 text-red-800" colSpan={6}>
                {msgs.join('; ')}
              </td>
              <td className="ps-2 pe-2 py-1 text-red-800">
                {t('imports.wizard.review.status.error')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
