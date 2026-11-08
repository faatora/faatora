import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { UnauthorizedError } from '../../../../lib/api';
import { useFirmContext } from '../../context/FirmContext';
import {
  fetchFirmDashboard,
  type FirmDashboard,
  type FirmDashboardIssue,
  type FirmDashboardPerClient,
  type FirmDashboardVatReturn,
  type IssueSeverity,
  type VatReturnStatus,
} from '../api';

type LoadState = 'loading' | 'ready' | 'error' | 'unauthenticated';

/**
 * W2-B consolidated firm dashboard.
 *
 * Fires GET /firms/:id/dashboard on mount via the shared apiFetch which
 * attaches the x-firm-id header from FirmContext / localStorage. The page
 * renders three zones: summary tiles across the top, a perClient table in
 * the middle, and a right-hand panel with the recent-issues feed and the
 * upcoming VAT returns list. All layout uses logical CSS properties so the
 * RTL translation flips cleanly.
 */
export function DashboardPage() {
  const { t } = useTranslation();
  const { id: firmIdParam } = useParams();
  const { activeFirm, switchFirm } = useFirmContext();

  const firmId = firmIdParam ?? activeFirm?.id ?? '';

  const [state, setState] = useState<LoadState>('loading');
  const [data, setData] = useState<FirmDashboard | null>(null);

  // Keep FirmContext aligned with the URL so the API client interceptor
  // sends the correct x-firm-id when a user deep-links the dashboard.
  useEffect(() => {
    if (!firmIdParam) return;
    if (activeFirm?.id === firmIdParam) return;
    switchFirm(firmIdParam);
  }, [firmIdParam, activeFirm?.id, switchFirm]);

  const load = useCallback(async () => {
    if (!firmId) {
      setState('error');
      return;
    }
    setState('loading');
    try {
      const d = await fetchFirmDashboard(firmId);
      setData(d);
      setState('ready');
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        setState('unauthenticated');
        return;
      }
      setState('error');
    }
  }, [firmId]);

  useEffect(() => {
    void load();
  }, [load]);

  const isEmptyFirm = useMemo(
    () => state === 'ready' && data !== null && data.summary.totalClients === 0,
    [state, data],
  );

  if (!firmId) {
    return (
      <section>
        <ShellCard>
          <p className="text-start text-sm text-slate-700" data-testid="dashboard-missing-firm">
            {t('firms.dashboard.missing_firm')}
          </p>
        </ShellCard>
      </section>
    );
  }

  if (state === 'unauthenticated') {
    return (
      <section>
        <ShellCard>
          <p className="text-start text-sm text-slate-700" data-testid="dashboard-sign-in">
            {t('firms.dashboard.sign_in')}
          </p>
        </ShellCard>
      </section>
    );
  }

  if (state === 'error') {
    return (
      <section>
        <ShellCard>
          <div
            role="alert"
            className="rounded-md border border-rose-200 bg-rose-50 ps-3 pe-3 py-2 text-start text-sm text-rose-900"
            data-testid="dashboard-error"
          >
            {t('firms.dashboard.load_error')}
          </div>
          <div className="mt-4">
            <button
              type="button"
              onClick={() => void load()}
              className="ps-4 pe-4 py-2 rounded-md border border-slate-300 bg-white text-slate-800 text-sm font-medium hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            >
              {t('firms.dashboard.retry')}
            </button>
          </div>
        </ShellCard>
      </section>
    );
  }

  if (state === 'loading' || data === null) {
    return <DashboardSkeleton />;
  }

  if (isEmptyFirm) {
    return (
      <section data-testid="dashboard-empty">
        <header className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-start text-xl font-semibold text-slate-900">
              {t('firms.dashboard.title')}
            </h1>
            <p className="mt-1 text-start text-sm text-slate-600">
              {activeFirm?.name ?? ''}
            </p>
          </div>
        </header>
        <ShellCard className="mt-6">
          <h2 className="text-start text-base font-semibold text-slate-900">
            {t('firms.dashboard.empty.title')}
          </h2>
          <p className="mt-2 text-start text-sm text-slate-700">
            {t('firms.dashboard.empty.body')}
          </p>
          <div className="mt-5">
            <Link
              to={`/firms/${encodeURIComponent(firmId)}/clients/new`}
              className="ps-4 pe-4 py-2 rounded-md bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            >
              {t('firms.dashboard.empty.cta')}
            </Link>
          </div>
        </ShellCard>
      </section>
    );
  }

  const { summary, perClient, issues, vatReturnsDue } = data;
  return (
    <section data-testid="dashboard-ready">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-start text-xl font-semibold text-slate-900">
            {t('firms.dashboard.title')}
          </h1>
          <p className="mt-1 text-start text-sm text-slate-600">{activeFirm?.name ?? ''}</p>
        </div>
      </header>

      <section
        aria-label={t('firms.dashboard.summary_aria')}
        className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6"
        data-testid="dashboard-summary"
      >
        <StatTile
          label={t('firms.dashboard.summary.clients')}
          value={String(summary.totalClients)}
          testId="tile-clients"
        />
        <StatTile
          label={t('firms.dashboard.summary.invoices_30d')}
          value={String(summary.totalInvoices30d)}
          testId="tile-invoices"
        />
        <StatTile
          label={t('firms.dashboard.summary.vat_collected')}
          value={formatOmr(summary.totalVatCollected30dOmr)}
          sub="OMR"
          testId="tile-vat"
        />
        <StatTile
          label={t('firms.dashboard.summary.pending_submission')}
          value={String(summary.pendingSubmissionCount)}
          testId="tile-pending"
          emphasis={summary.pendingSubmissionCount > 0 ? 'warning' : undefined}
        />
        <StatTile
          label={t('firms.dashboard.summary.failed')}
          value={String(summary.failedClearanceCount)}
          testId="tile-failed"
          emphasis={summary.failedClearanceCount > 0 ? 'error' : undefined}
        />
        <StatTile
          label={t('firms.dashboard.summary.overdue')}
          value={String(summary.overdueInvoiceCount)}
          testId="tile-overdue"
          emphasis={summary.overdueInvoiceCount > 0 ? 'warning' : undefined}
        />
      </section>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <PerClientTable rows={perClient} />
        <aside className="space-y-6 lg:col-span-1">
          <IssuesPanel issues={issues} />
          <VatReturnsPanel returns={vatReturnsDue} />
        </aside>
      </div>
    </section>
  );
}

// --- summary tile ---

interface StatTileProps {
  label: string;
  value: string;
  sub?: string;
  emphasis?: 'warning' | 'error';
  testId?: string;
}

function StatTile({ label, value, sub, emphasis, testId }: StatTileProps) {
  const ring =
    emphasis === 'error'
      ? 'ring-1 ring-rose-200 bg-rose-50'
      : emphasis === 'warning'
        ? 'ring-1 ring-amber-200 bg-amber-50'
        : 'bg-white';
  const valueColor =
    emphasis === 'error'
      ? 'text-rose-900'
      : emphasis === 'warning'
        ? 'text-amber-900'
        : 'text-slate-900';
  return (
    <div
      className={`rounded-xl border border-slate-200 p-4 shadow-sm ${ring}`}
      data-testid={testId}
    >
      <p className="text-start text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </p>
      <p className={`mt-1 text-start text-2xl font-bold ${valueColor}`}>
        {value}
        {sub && <span className="ms-1 text-sm font-medium text-slate-500">{sub}</span>}
      </p>
    </div>
  );
}

// --- per-client table ---

function PerClientTable({ rows }: { rows: FirmDashboardPerClient[] }) {
  const { t } = useTranslation();
  return (
    <section
      className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm lg:col-span-2"
      data-testid="dashboard-per-client"
    >
      <h2 className="text-start text-sm font-semibold text-slate-900 ps-4 pe-4 py-3 border-b border-slate-100">
        {t('firms.dashboard.per_client.title')}
      </h2>
      {rows.length === 0 ? (
        <p className="text-start text-sm text-slate-600 ps-4 pe-4 py-4">
          {t('firms.dashboard.per_client.empty')}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50">
              <tr>
                <Th>{t('firms.dashboard.per_client.col.client')}</Th>
                <Th>{t('firms.dashboard.per_client.col.invoices_30d')}</Th>
                <Th>{t('firms.dashboard.per_client.col.vat_collected')}</Th>
                <Th>{t('firms.dashboard.per_client.col.last_submission')}</Th>
                <Th>{t('firms.dashboard.per_client.col.issues')}</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => (
                <tr key={r.tenantId} data-testid={`per-client-row-${r.tenantId}`}>
                  <Td className="font-medium text-slate-900">{r.tenantName}</Td>
                  <Td className="text-slate-700">{r.invoices30d}</Td>
                  <Td className="text-slate-700">{formatOmr(r.vatCollected30dOmr)}</Td>
                  <Td className="text-slate-700">
                    {r.lastSubmissionAt ? formatDate(r.lastSubmissionAt) : '-'}
                  </Td>
                  <Td>
                    {r.openIssues > 0 ? (
                      <span className="inline-flex items-center rounded-full bg-amber-100 ps-2 pe-2 py-0.5 text-xs font-semibold text-amber-900">
                        {r.openIssues}
                      </span>
                    ) : (
                      <span className="text-slate-500">0</span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// --- issues panel ---

function IssuesPanel({ issues }: { issues: FirmDashboardIssue[] }) {
  const { t } = useTranslation();
  return (
    <section
      className="rounded-xl border border-slate-200 bg-white shadow-sm"
      data-testid="dashboard-issues"
    >
      <h2 className="text-start text-sm font-semibold text-slate-900 ps-4 pe-4 py-3 border-b border-slate-100">
        {t('firms.dashboard.issues.title')}
      </h2>
      {issues.length === 0 ? (
        <p className="text-start text-sm text-slate-600 ps-4 pe-4 py-4">
          {t('firms.dashboard.issues.empty')}
        </p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {issues.map((i, idx) => (
            <li
              key={`${i.invoiceId ?? 'na'}-${idx}`}
              className="ps-4 pe-4 py-3 flex items-start gap-3"
              data-testid="dashboard-issue"
            >
              <SeverityDot severity={i.severity} />
              <div className="min-w-0 flex-1">
                <p className="text-start text-sm text-slate-900 break-words">{i.message}</p>
                <p className="mt-1 text-start text-xs text-slate-500">
                  {formatDateTime(i.createdAt)}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SeverityDot({ severity }: { severity: IssueSeverity }) {
  const color =
    severity === 'error'
      ? 'bg-rose-500'
      : severity === 'warning'
        ? 'bg-amber-500'
        : 'bg-sky-500';
  return (
    <span
      aria-hidden="true"
      className={`mt-1 inline-block h-2 w-2 rounded-full ${color}`}
    />
  );
}

// --- vat returns panel ---

function VatReturnsPanel({ returns }: { returns: FirmDashboardVatReturn[] }) {
  const { t } = useTranslation();
  return (
    <section
      className="rounded-xl border border-slate-200 bg-white shadow-sm"
      data-testid="dashboard-vat-returns"
    >
      <h2 className="text-start text-sm font-semibold text-slate-900 ps-4 pe-4 py-3 border-b border-slate-100">
        {t('firms.dashboard.vat_returns.title')}
      </h2>
      {returns.length === 0 ? (
        <p className="text-start text-sm text-slate-600 ps-4 pe-4 py-4">
          {t('firms.dashboard.vat_returns.empty')}
        </p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {returns.map((v) => (
            <li
              key={v.tenantId}
              className="ps-4 pe-4 py-3 flex items-start justify-between gap-3"
              data-testid="dashboard-vat-return"
            >
              <div className="min-w-0 flex-1">
                <p className="text-start text-sm font-medium text-slate-900 break-words">
                  {v.tenantName}
                </p>
                <p className="mt-1 text-start text-xs text-slate-500">
                  {v.periodStart} to {v.periodEnd}
                </p>
                <p className="mt-0.5 text-start text-xs text-slate-500">
                  {t('firms.dashboard.vat_returns.due', { date: v.dueDate })}
                </p>
              </div>
              <VatStatusBadge status={v.status} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function VatStatusBadge({ status }: { status: VatReturnStatus }) {
  const { t } = useTranslation();
  const style =
    status === 'overdue'
      ? 'bg-rose-100 text-rose-900'
      : status === 'submitted'
        ? 'bg-emerald-100 text-emerald-900'
        : 'bg-slate-100 text-slate-800';
  return (
    <span
      className={`inline-flex items-center rounded-full ps-2 pe-2 py-0.5 text-xs font-semibold ${style}`}
      data-testid={`vat-status-${status}`}
    >
      {t(`firms.dashboard.vat_returns.status.${status}`)}
    </span>
  );
}

// --- skeleton + shell ---

function DashboardSkeleton() {
  return (
    <section data-testid="dashboard-loading" aria-busy="true">
      <div className="h-6 w-56 rounded bg-slate-200 animate-pulse" />
      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
          >
            <div className="h-3 w-20 rounded bg-slate-200 animate-pulse" />
            <div className="mt-3 h-6 w-12 rounded bg-slate-200 animate-pulse" />
          </div>
        ))}
      </div>
      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm lg:col-span-2 h-64 animate-pulse" />
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm h-64 animate-pulse" />
      </div>
    </section>
  );
}

function ShellCard({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-xl border border-slate-200 bg-white p-6 shadow-sm ${className ?? ''}`}
    >
      {children}
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th
      scope="col"
      className="ps-4 pe-4 py-2 text-start text-xs font-semibold uppercase tracking-wide text-slate-600"
    >
      {children}
    </th>
  );
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={`ps-4 pe-4 py-2 text-start text-sm ${className ?? ''}`}>{children}</td>;
}

function formatOmr(raw: string): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  return n.toLocaleString(undefined, { minimumFractionDigits: 3, maximumFractionDigits: 3 });
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toISOString().slice(0, 10);
  } catch {
    return iso;
  }
}

function formatDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}`;
  } catch {
    return iso;
  }
}

export default DashboardPage;
