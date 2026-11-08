// Client onboarding wizard (W2-C).
//
// Two modes:
//   "single"  -- one form, POST /firms/:id/clients/onboard.
//   "batch"   -- CSV paste/upload, in-memory parse + validation preview,
//               POST /firms/:id/clients/batch on commit.
//
// Keep this component self-contained: a dependency on the router lives
// behind the optional `onCompleted` callback, so the test harness can
// drive it without a routing provider.

import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  batchOnboard,
  onboardClient,
  type BatchOnboardFailure,
  type ClientTenantRecord,
  type CreateClientTenantInput,
} from '../api/clients';
import { mapCsvRows, parseCsv } from '../components/csvParser';

type Mode = 'single' | 'batch';

export interface ClientOnboardingWizardPageProps {
  firmId: string;
  /** Called when a single-mode submission succeeds (e.g. navigate back). */
  onCompleted?: (record: ClientTenantRecord) => void;
  /** Called when a batch submission finishes (success or partial). */
  onBatchCompleted?: (created: ClientTenantRecord[], failed: BatchOnboardFailure[]) => void;
}

export function ClientOnboardingWizardPage(props: ClientOnboardingWizardPageProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Mode>('single');

  return (
    <div className="mx-auto max-w-3xl">
      <header>
        <h1 className="text-start text-2xl font-bold text-slate-900">
          {t('clients.wizard.title')}
        </h1>
        <p className="mt-1 text-start text-sm text-slate-600">{t('clients.wizard.subtitle')}</p>
      </header>

      <div
        role="tablist"
        aria-label={t('clients.wizard.modeLabel')}
        className="mt-5 inline-flex rounded-lg border border-slate-200 bg-white p-1"
      >
        <ModeButton
          active={mode === 'single'}
          onClick={() => setMode('single')}
          label={t('clients.wizard.single')}
        />
        <ModeButton
          active={mode === 'batch'}
          onClick={() => setMode('batch')}
          label={t('clients.wizard.batch')}
        />
      </div>

      {mode === 'single' ? (
        <SingleOnboardForm firmId={props.firmId} onCompleted={props.onCompleted} />
      ) : (
        <BatchOnboardForm firmId={props.firmId} onBatchCompleted={props.onBatchCompleted} />
      )}
    </div>
  );
}

function ModeButton(props: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      role="tab"
      aria-selected={props.active}
      type="button"
      onClick={props.onClick}
      className={`ps-4 pe-4 py-2 text-sm font-medium rounded-md transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
        props.active ? 'bg-indigo-600 text-white' : 'text-slate-700 hover:bg-slate-100'
      }`}
    >
      {props.label}
    </button>
  );
}

// -------------------- single --------------------

function SingleOnboardForm({
  firmId,
  onCompleted,
}: {
  firmId: string;
  onCompleted?: (r: ClientTenantRecord) => void;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState<CreateClientTenantInput>({
    tenantName: '',
    crNumber: '',
    vatin: '',
    country: 'OM',
    accessLevel: 'full',
    engagementType: 'ongoing',
    shopOwnerEmail: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<ClientTenantRecord | null>(null);

  const canSubmit =
    form.tenantName.trim().length > 0 &&
    form.crNumber.trim().length > 0 &&
    form.vatin.trim().length > 0 &&
    !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const payload: CreateClientTenantInput = {
        tenantName: form.tenantName.trim(),
        crNumber: form.crNumber.trim(),
        vatin: form.vatin.trim(),
        country: form.country || 'OM',
        accessLevel: form.accessLevel,
        engagementType: form.engagementType,
        shopOwnerEmail: form.shopOwnerEmail?.trim() || undefined,
      };
      const record = await onboardClient(firmId, payload);
      setSuccess(record);
      onCompleted?.(record);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (success) {
    return (
      <div role="status" className="mt-6 rounded-xl border border-emerald-200 bg-emerald-50 p-6">
        <p className="text-start text-sm font-semibold text-emerald-900">
          {t('clients.wizard.single.success', { name: success.tenantName })}
        </p>
        <p className="mt-1 text-start text-xs text-emerald-800">
          {t('clients.wizard.single.successHint')}
        </p>
        <button
          type="button"
          onClick={() => {
            setSuccess(null);
            setForm({
              tenantName: '',
              crNumber: '',
              vatin: '',
              country: 'OM',
              accessLevel: 'full',
              engagementType: 'ongoing',
              shopOwnerEmail: '',
            });
          }}
          className="mt-4 ps-4 pe-4 py-2 rounded-md bg-emerald-700 text-white text-sm font-medium hover:bg-emerald-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600"
        >
          {t('clients.wizard.single.addAnother')}
        </button>
      </div>
    );
  }

  return (
    <form
      className="mt-6 rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field
          id="tenantName"
          label={t('clients.wizard.single.tenantName')}
          value={form.tenantName}
          onChange={(v) => setForm({ ...form, tenantName: v })}
        />
        <Field
          id="shopOwnerEmail"
          type="email"
          label={t('clients.wizard.single.shopOwnerEmail')}
          value={form.shopOwnerEmail ?? ''}
          onChange={(v) => setForm({ ...form, shopOwnerEmail: v })}
        />
        <Field
          id="crNumber"
          label={t('clients.wizard.single.crNumber')}
          value={form.crNumber}
          onChange={(v) => setForm({ ...form, crNumber: v })}
        />
        <Field
          id="vatin"
          label={t('clients.wizard.single.vatin')}
          value={form.vatin}
          onChange={(v) => setForm({ ...form, vatin: v })}
        />
        <Field
          id="country"
          label={t('clients.wizard.single.country')}
          value={form.country ?? 'OM'}
          onChange={(v) => setForm({ ...form, country: v.toUpperCase() })}
        />
        <SelectField
          id="accessLevel"
          label={t('clients.wizard.single.accessLevel')}
          value={form.accessLevel}
          onChange={(v) => setForm({ ...form, accessLevel: v as 'full' | 'read_only' })}
          options={[
            { v: 'full', l: t('clients.wizard.single.accessLevel.full') },
            { v: 'read_only', l: t('clients.wizard.single.accessLevel.readOnly') },
          ]}
        />
        <SelectField
          id="engagementType"
          label={t('clients.wizard.single.engagementType')}
          value={form.engagementType}
          onChange={(v) => setForm({ ...form, engagementType: v as 'ongoing' | 'periodic' })}
          options={[
            { v: 'ongoing', l: t('clients.wizard.single.engagementType.ongoing') },
            { v: 'periodic', l: t('clients.wizard.single.engagementType.periodic') },
          ]}
        />
      </div>

      {error && (
        <div
          role="alert"
          className="mt-4 rounded-md border border-rose-200 bg-rose-50 ps-3 pe-3 py-2 text-start text-sm text-rose-900"
        >
          {error}
        </div>
      )}

      <div className="mt-6 flex items-center justify-end gap-3">
        <button
          type="submit"
          disabled={!canSubmit}
          className="ps-5 pe-5 py-2 rounded-md bg-indigo-600 text-white font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        >
          {busy ? t('clients.wizard.single.submitting') : t('clients.wizard.single.submit')}
        </button>
      </div>
    </form>
  );
}

// -------------------- batch --------------------

function BatchOnboardForm({
  firmId,
  onBatchCompleted,
}: {
  firmId: string;
  onBatchCompleted?: (c: ClientTenantRecord[], f: BatchOnboardFailure[]) => void;
}) {
  const { t } = useTranslation();
  const [csvText, setCsvText] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    created: ClientTenantRecord[];
    failed: BatchOnboardFailure[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const parsed = useMemo(() => {
    if (!csvText.trim()) return null;
    const { rows } = parseCsv(csvText);
    return mapCsvRows(rows);
  }, [csvText]);

  const validRows = useMemo(() => (parsed ?? []).filter((r) => r._errors.length === 0), [parsed]);
  const invalidRows = useMemo(() => (parsed ?? []).filter((r) => r._errors.length > 0), [parsed]);

  const onFile = useCallback(async (file: File) => {
    const text = await file.text();
    setCsvText(text);
  }, []);

  const submit = async () => {
    if (!validRows.length || busy) return;
    setBusy(true);
    setError(null);
    try {
      // Cap at 50 per API contract.
      const toSend: CreateClientTenantInput[] = validRows.slice(0, 50).map((r) => ({
        tenantName: r.tenantName,
        crNumber: r.crNumber,
        vatin: r.vatin,
        country: r.country,
        accessLevel: r.accessLevel,
        engagementType: r.engagementType,
        shopOwnerEmail: r.shopOwnerEmail,
      }));
      const res = await batchOnboard(firmId, toSend);
      setResult(res);
      onBatchCompleted?.(res.created, res.failed);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <div className="mt-6 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-start text-sm font-semibold text-slate-900">
          {t('clients.wizard.batch.resultsHeader', {
            created: result.created.length,
            failed: result.failed.length,
          })}
        </p>
        {result.failed.length > 0 && (
          <ul className="mt-3 list-disc ps-6 text-start text-xs text-rose-900">
            {result.failed.map((f, i) => (
              <li key={i}>
                <span className="font-medium">#{f.index + 1}</span> {f.dto.tenantName}: {f.error}
              </li>
            ))}
          </ul>
        )}
        <button
          type="button"
          onClick={() => {
            setResult(null);
            setCsvText('');
          }}
          className="mt-4 ps-4 pe-4 py-2 rounded-md bg-slate-700 text-white text-sm font-medium hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-600"
        >
          {t('clients.wizard.batch.startOver')}
        </button>
      </div>
    );
  }

  return (
    <div className="mt-6 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <label htmlFor="csv-file" className="block text-start text-sm font-medium text-slate-800">
        {t('clients.wizard.batch.fileLabel')}
      </label>
      <input
        id="csv-file"
        type="file"
        accept=".csv,text/csv"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void onFile(f);
        }}
        className="mt-2 block text-start text-sm text-slate-700"
      />
      <p className="mt-2 text-start text-xs text-slate-500">{t('clients.wizard.batch.fileHint')}</p>

      <label
        htmlFor="csv-text"
        className="mt-5 block text-start text-sm font-medium text-slate-800"
      >
        {t('clients.wizard.batch.pasteLabel')}
      </label>
      <textarea
        id="csv-text"
        value={csvText}
        onChange={(e) => setCsvText(e.target.value)}
        rows={6}
        className="mt-2 w-full rounded-md border border-slate-300 bg-white ps-3 pe-3 py-2 text-start font-mono text-xs text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        placeholder="tenantName,crNumber,vatin,country,accessLevel,engagementType,shopOwnerEmail"
      />

      {parsed && parsed.length > 0 && (
        <div className="mt-5">
          <h2 className="text-start text-sm font-semibold text-slate-900">
            {t('clients.wizard.batch.previewHeader', {
              total: parsed.length,
              valid: validRows.length,
              invalid: invalidRows.length,
            })}
          </h2>
          <div className="mt-2 overflow-x-auto rounded-md border border-slate-200">
            <table className="min-w-full divide-y divide-slate-200 text-xs">
              <thead className="bg-slate-50">
                <tr>
                  <Th>#</Th>
                  <Th>{t('clients.wizard.batch.col.tenantName')}</Th>
                  <Th>{t('clients.wizard.batch.col.crNumber')}</Th>
                  <Th>{t('clients.wizard.batch.col.vatin')}</Th>
                  <Th>{t('clients.wizard.batch.col.notes')}</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {parsed.map((r) => (
                  <tr key={r._rowIndex} className={r._errors.length > 0 ? 'bg-rose-50' : ''}>
                    <Td>{r._rowIndex}</Td>
                    <Td>{r.tenantName || '--'}</Td>
                    <Td>{r.crNumber || '--'}</Td>
                    <Td>{r.vatin || '--'}</Td>
                    <Td className="text-rose-800">
                      {r._errors.length > 0 ? r._errors.join('; ') : ''}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="mt-4 rounded-md border border-rose-200 bg-rose-50 ps-3 pe-3 py-2 text-start text-sm text-rose-900"
        >
          {error}
        </div>
      )}

      <div className="mt-6 flex items-center justify-end gap-3">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={validRows.length === 0 || busy}
          className="ps-5 pe-5 py-2 rounded-md bg-indigo-600 text-white font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        >
          {busy
            ? t('clients.wizard.batch.submitting')
            : t('clients.wizard.batch.submit', { count: Math.min(validRows.length, 50) })}
        </button>
      </div>
    </div>
  );
}

// -------------------- field atoms --------------------

function Field(props: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <div>
      <label htmlFor={props.id} className="block text-start text-sm font-medium text-slate-800">
        {props.label}
      </label>
      <input
        id={props.id}
        type={props.type ?? 'text'}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        className="mt-1 w-full rounded-md border border-slate-300 bg-white ps-3 pe-3 py-2 text-start text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
      />
    </div>
  );
}

function SelectField(props: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ v: string; l: string }>;
}) {
  return (
    <div>
      <label htmlFor={props.id} className="block text-start text-sm font-medium text-slate-800">
        {props.label}
      </label>
      <select
        id={props.id}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        className="mt-1 w-full rounded-md border border-slate-300 bg-white ps-3 pe-3 py-2 text-start text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
      >
        {props.options.map((o) => (
          <option key={o.v} value={o.v}>
            {o.l}
          </option>
        ))}
      </select>
    </div>
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
  return <td className={`ps-3 pe-3 py-1.5 text-start ${className ?? ''}`}>{children}</td>;
}

export default ClientOnboardingWizardPage;
