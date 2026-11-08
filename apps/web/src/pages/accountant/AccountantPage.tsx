import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AccountantUnauthorizedError,
  createFirm,
  fetchKpis,
  getFirm,
  listTenants,
  switchToTenant,
  type Firm,
  type TenantKpis,
  type TenantSummary,
} from './api';
import { LinkClientDialog } from './LinkClientDialog';

type LoadState = 'loading' | 'ready' | 'unauthorized' | 'error';

export function AccountantPage() {
  const { t } = useTranslation();
  const [state, setState] = useState<LoadState>('loading');
  const [firm, setFirm] = useState<Firm | null>(null);
  const [tenants, setTenants] = useState<TenantSummary[]>([]);
  const [kpis, setKpis] = useState<TenantKpis[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setState('loading');
    try {
      const f = await getFirm();
      setFirm(f);
      if (!f) {
        setTenants([]);
        setKpis([]);
        setState('ready');
        return;
      }
      const [ts, ks] = await Promise.all([listTenants(), fetchKpis()]);
      setTenants(ts);
      setKpis(ks);
      setState('ready');
    } catch (err) {
      if (err instanceof AccountantUnauthorizedError) {
        setState('unauthorized');
        return;
      }
      setState('error');
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const totals = useMemo(() => {
    const totalInvoices = kpis.reduce((a, k) => a + Number(k.invoiceCount || 0), 0);
    const totalVat = kpis.reduce((a, k) => a + Number(k.vatOutput || 0), 0);
    const totalGrand = kpis.reduce((a, k) => a + Number(k.invoiceTotal || 0), 0);
    const totalOverdue = kpis.reduce((a, k) => a + Number(k.overdueArCount || 0), 0);
    return {
      clientCount: tenants.length,
      totalInvoices,
      totalVat,
      totalGrand,
      totalOverdue,
    };
  }, [kpis, tenants]);

  if (state === 'unauthorized') {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-start text-sm text-slate-800">{t('accountant.pleaseLogIn')}</p>
      </div>
    );
  }

  if (state === 'loading') {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-start text-sm text-slate-600">{t('accountant.loading')}</p>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div
        role="alert"
        className="rounded-md border border-rose-200 bg-rose-50 ps-3 pe-3 py-2 text-start text-sm text-rose-900"
      >
        {t('accountant.loadError')}
      </div>
    );
  }

  if (!firm) {
    const canCreate = createName.trim().length > 0;
    const submit = async () => {
      if (!canCreate || createBusy) return;
      setCreateBusy(true);
      setCreateError(null);
      try {
        await createFirm({ name: createName.trim() });
        setCreateName('');
        await reload();
      } catch (err) {
        if (err instanceof AccountantUnauthorizedError) {
          setState('unauthorized');
          return;
        }
        setCreateError(t('accountant.createError'));
      } finally {
        setCreateBusy(false);
      }
    };
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-start text-xl font-semibold text-slate-900">
          {t('accountant.dashboard')}
        </h1>
        <p className="mt-2 text-start text-sm text-slate-700">{t('accountant.no_firm_cta')}</p>

        <div className="mt-5">
          <label
            htmlFor="firm-name"
            className="block text-start text-sm font-medium text-slate-800"
          >
            {t('accountant.firm.name')}
          </label>
          <input
            id="firm-name"
            type="text"
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
            className="mt-2 w-full rounded-md border border-slate-300 bg-white ps-3 pe-3 py-2 text-start text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          />
        </div>

        {createError && (
          <div
            role="alert"
            className="mt-4 rounded-md border border-rose-200 bg-rose-50 ps-3 pe-3 py-2 text-start text-sm text-rose-900"
          >
            {createError}
          </div>
        )}

        <div className="mt-5">
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!canCreate || createBusy}
            className="ps-5 pe-5 py-2 rounded-md bg-indigo-600 text-white font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            {createBusy ? t('accountant.creating') : t('accountant.firm.create')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <header className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-start text-xl font-semibold text-slate-900">
            {t('accountant.dashboard')}
          </h1>
          <p className="mt-1 text-start text-sm text-slate-600">{firm.name}</p>
        </div>
        <button
          type="button"
          onClick={() => setDialogOpen(true)}
          className="ps-4 pe-4 py-2 rounded-md bg-indigo-600 text-white font-medium hover:bg-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        >
          <span aria-hidden="true" className="me-1">
            +
          </span>
          {t('accountant.link_client')}
        </button>
      </header>

      <section className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label={t('accountant.clients')} value={String(totals.clientCount)} />
        <StatTile
          label={t('accountant.invoices_this_month')}
          value={String(totals.totalInvoices)}
        />
        <StatTile label={t('accountant.vat_output')} value={totals.totalVat.toFixed(3)} sub="OMR" />
        <StatTile label={t('accountant.overdue_ar')} value={String(totals.totalOverdue)} />
      </section>

      <section className="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <h2 className="text-start text-sm font-semibold text-slate-900 ps-4 pe-4 py-3 border-b border-slate-100">
          {t('accountant.clients')}
        </h2>
        {tenants.length === 0 ? (
          <p className="text-start text-sm text-slate-600 ps-4 pe-4 py-4">
            {t('accountant.no_clients')}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50">
                <tr>
                  <Th>{t('accountant.col.name')}</Th>
                  <Th>{t('accountant.col.status')}</Th>
                  <Th>{t('accountant.invoices_this_month')}</Th>
                  <Th>{t('accountant.overdue_ar')}</Th>
                  <Th>&nbsp;</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {tenants.map((row) => {
                  const k = kpis.find((x) => x.tenantId === row.tenantId);
                  return (
                    <tr key={row.tenantId}>
                      <Td>
                        <span className="font-medium text-slate-900">{row.tenantName}</span>
                        {row.referred && (
                          <span className="ms-2 inline-flex items-center rounded-full bg-emerald-100 ps-2 pe-2 py-0.5 text-xs font-semibold text-emerald-800">
                            {t('accountant.referred_badge')}
                          </span>
                        )}
                      </Td>
                      <Td className="text-slate-700">{row.tenantStatus}</Td>
                      <Td className="text-slate-700">{k?.invoiceCount ?? 0}</Td>
                      <Td className="text-slate-700">{k?.overdueArCount ?? 0}</Td>
                      <Td className="text-end">
                        <button
                          type="button"
                          onClick={() => {
                            switchToTenant(row.tenantId);
                            window.location.hash = '#pos';
                          }}
                          className="ps-3 pe-3 py-1.5 rounded-md border border-indigo-200 bg-indigo-50 text-indigo-700 text-sm font-medium hover:bg-indigo-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                        >
                          {t('accountant.switch_to')}
                        </button>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <LinkClientDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onLinked={() => void reload()}
      />
    </div>
  );
}

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-start text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </p>
      <p className="mt-1 text-start text-2xl font-bold text-slate-900">
        {value}
        {sub && <span className="ms-1 text-sm font-medium text-slate-500">{sub}</span>}
      </p>
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

export default AccountantPage;
