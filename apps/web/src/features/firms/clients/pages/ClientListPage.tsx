// Client list page (W2-C).
//
// Shows every active and revoked firm_client_tenants row with filters
// for engagement-type and revocation status. Actions wire to:
//   - revoke (DELETE /firms/:id/clients/:tenantId)
//   - open onboarding wizard
//   - impersonate "act as this client" — writes the tenant id into
//     FirmContext, which surfaces it as x-impersonate-tenant-id on every
//     subsequent API call. Backend enforcement is a follow-up (see the
//     startImpersonation TODO in ../api/clients.ts).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { listClients, revokeClient, startImpersonation } from '../api/clients';
import { useFirmContext } from '../../context/FirmContext';
import type { FirmClientTenant, FirmMemberRole } from '../../types';

type StatusFilter = 'all' | 'active' | 'revoked';
type EngagementFilter = 'all' | 'ongoing' | 'periodic';

/**
 * Roles allowed to "act as" a client tenant. `read_only` is deliberately
 * excluded — a reviewer who cannot write to the firm should not be able
 * to post invoices under a client's name either. The backend follow-up
 * mirrors this check for defence in depth.
 */
const IMPERSONATE_ALLOWED_ROLES: ReadonlySet<FirmMemberRole> = new Set([
  'owner',
  'partner',
  'staff',
]);

export interface ClientListPageProps {
  firmId: string;
  onAddClient?: () => void;
  onViewInvoices?: (tenantId: string) => void;
}

export function ClientListPage(props: ClientListPageProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { firmList, startActingAs } = useFirmContext();
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [rows, setRows] = useState<FirmClientTenant[]>([]);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active');
  const [engagementFilter, setEngagementFilter] = useState<EngagementFilter>('all');
  const [busyRevokeId, setBusyRevokeId] = useState<string | null>(null);
  const [busyActAsId, setBusyActAsId] = useState<string | null>(null);

  const myRole = useMemo<FirmMemberRole | null>(() => {
    const membership = firmList.find((m) => m.firm.id === props.firmId);
    return membership?.role ?? null;
  }, [firmList, props.firmId]);

  const canImpersonate = myRole != null && IMPERSONATE_ALLOWED_ROLES.has(myRole);

  const reload = useCallback(async () => {
    setState('loading');
    try {
      const data = await listClients(props.firmId);
      setRows(data);
      setState('ready');
    } catch {
      setState('error');
    }
  }, [props.firmId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      // The Wave 1 listClientTenants endpoint returns only active links,
      // so "revoked" filter will currently show nothing. Left in place
      // for a later endpoint toggle.
      if (statusFilter === 'revoked') return false;
      if (engagementFilter !== 'all' && r.engagementType !== engagementFilter) return false;
      return true;
    });
  }, [rows, statusFilter, engagementFilter]);

  const onRevoke = async (tenantId: string) => {
    if (!window.confirm(t('clients.list.revokeConfirm'))) return;
    setBusyRevokeId(tenantId);
    try {
      await revokeClient(props.firmId, tenantId);
      await reload();
    } finally {
      setBusyRevokeId(null);
    }
  };

  const onActAs = async (tenantId: string) => {
    if (!canImpersonate || busyActAsId) return;
    setBusyActAsId(tenantId);
    try {
      // Fire-and-shrug: if the backend endpoint exists, it returns a
      // ticket; if not, startImpersonation swallows the 404 so the UX
      // stays usable while the server-side piece lands in the next PR.
      await startImpersonation(props.firmId, tenantId).catch(() => {
        /* already-logged; proceed with frontend-only impersonation */
      });
      startActingAs(tenantId);
      navigate('/');
    } finally {
      setBusyActAsId(null);
    }
  };

  return (
    <div className="mx-auto max-w-5xl">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-start text-2xl font-bold text-slate-900">
            {t('clients.list.title')}
          </h1>
          <p className="mt-1 text-start text-sm text-slate-600">{t('clients.list.subtitle')}</p>
        </div>
        <button
          type="button"
          onClick={props.onAddClient}
          className="ps-4 pe-4 py-2 rounded-md bg-indigo-600 text-white font-medium hover:bg-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        >
          <span aria-hidden="true" className="me-1">
            +
          </span>
          {t('clients.list.addNew')}
        </button>
      </header>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <FilterSelect
          label={t('clients.list.filter.status')}
          value={statusFilter}
          onChange={(v) => setStatusFilter(v as StatusFilter)}
          options={[
            { v: 'active', l: t('clients.list.filter.active') },
            { v: 'revoked', l: t('clients.list.filter.revoked') },
            { v: 'all', l: t('clients.list.filter.all') },
          ]}
        />
        <FilterSelect
          label={t('clients.list.filter.engagement')}
          value={engagementFilter}
          onChange={(v) => setEngagementFilter(v as EngagementFilter)}
          options={[
            { v: 'all', l: t('clients.list.filter.all') },
            { v: 'ongoing', l: t('clients.list.filter.ongoing') },
            { v: 'periodic', l: t('clients.list.filter.periodic') },
          ]}
        />
      </div>

      <section className="mt-5 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        {state === 'loading' && (
          <p className="text-start text-sm text-slate-600 ps-4 pe-4 py-6">
            {t('clients.list.loading')}
          </p>
        )}
        {state === 'error' && (
          <p role="alert" className="text-start text-sm text-rose-800 ps-4 pe-4 py-6">
            {t('clients.list.error')}
          </p>
        )}
        {state === 'ready' && filtered.length === 0 && (
          <p className="text-start text-sm text-slate-600 ps-4 pe-4 py-6">
            {t('clients.list.empty')}
          </p>
        )}
        {state === 'ready' && filtered.length > 0 && (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50">
                <tr>
                  <Th>{t('clients.list.col.name')}</Th>
                  <Th>{t('clients.list.col.engagement')}</Th>
                  <Th>{t('clients.list.col.accessLevel')}</Th>
                  <Th>{t('clients.list.col.actions')}</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.map((r) => (
                  <tr key={r.tenantId}>
                    <Td>
                      <span className="font-medium text-slate-900">{r.tenantName}</span>
                    </Td>
                    <Td className="text-slate-700">
                      {t(`clients.list.filter.${r.engagementType}`)}
                    </Td>
                    <Td className="text-slate-700">
                      {r.accessLevel === 'read_only'
                        ? t('clients.wizard.single.accessLevel.readOnly')
                        : t('clients.wizard.single.accessLevel.full')}
                    </Td>
                    <Td className="text-end">
                      <div className="inline-flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => props.onViewInvoices?.(r.tenantId)}
                          className="ps-3 pe-3 py-1.5 rounded-md border border-slate-200 text-slate-700 text-sm font-medium hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
                        >
                          {t('clients.list.action.viewInvoices')}
                        </button>
                        <button
                          type="button"
                          onClick={() => void onActAs(r.tenantId)}
                          disabled={!canImpersonate || busyActAsId === r.tenantId}
                          title={
                            canImpersonate
                              ? t('clients.actAsTooltip')
                              : t('clients.actAsNoPermission')
                          }
                          aria-label={t('clients.actAsFor', { client: r.tenantName })}
                          className="ps-3 pe-3 py-1.5 rounded-md border border-indigo-200 bg-indigo-50 text-indigo-700 text-sm font-medium hover:bg-indigo-100 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
                        >
                          {busyActAsId === r.tenantId
                            ? t('clients.actAsStarting')
                            : t('clients.actAs')}
                        </button>
                        <button
                          type="button"
                          onClick={() => void onRevoke(r.tenantId)}
                          disabled={busyRevokeId === r.tenantId}
                          className="ps-3 pe-3 py-1.5 rounded-md border border-rose-200 bg-rose-50 text-rose-700 text-sm font-medium hover:bg-rose-100 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
                        >
                          {busyRevokeId === r.tenantId
                            ? t('clients.list.action.revoking')
                            : t('clients.list.action.revoke')}
                        </button>
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function FilterSelect(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ v: string; l: string }>;
}) {
  return (
    <label className="inline-flex flex-col text-start">
      <span className="text-xs font-medium text-slate-700">{props.label}</span>
      <select
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        className="mt-1 rounded-md border border-slate-300 bg-white ps-3 pe-8 py-1.5 text-sm text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
      >
        {props.options.map((o) => (
          <option key={o.v} value={o.v}>
            {o.l}
          </option>
        ))}
      </select>
    </label>
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

export default ClientListPage;
