import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router-dom';
import { UnauthorizedError } from '../../../lib/api';
import { inviteFirmMember, listFirmMembers, removeFirmMember } from '../api';
import { useFirmContext } from '../context/FirmContext';
import { FIRM_MEMBER_ROLES, type FirmMember, type FirmMemberRole } from '../types';

type LoadState = 'loading' | 'ready' | 'error' | 'unauthenticated';

const MANAGE_ROLES: FirmMemberRole[] = ['owner', 'partner'];

function canManage(role: FirmMemberRole | null): boolean {
  if (!role) return false;
  return MANAGE_ROLES.includes(role);
}

export function FirmMembersPage() {
  const { t } = useTranslation();
  const { id: firmIdParam } = useParams();
  const { activeFirm, switchFirm } = useFirmContext();

  const firmId = firmIdParam ?? activeFirm?.id ?? '';
  const [members, setMembers] = useState<FirmMember[]>([]);
  const [state, setState] = useState<LoadState>('loading');
  const [currentRole, setCurrentRole] = useState<FirmMemberRole | null>(null);

  const [inviteOpen, setInviteOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<FirmMember | null>(null);

  // Ensure the firm context matches the route — W2-B dashboard also does this,
  // we do it defensively so that direct links set the correct x-firm-id header.
  useEffect(() => {
    if (!firmIdParam) return;
    if (activeFirm?.id === firmIdParam) return;
    switchFirm(firmIdParam);
  }, [firmIdParam, activeFirm?.id, switchFirm]);

  const reload = useCallback(async () => {
    if (!firmId) {
      setState('error');
      return;
    }
    setState('loading');
    try {
      const data = await listFirmMembers(firmId);
      setMembers(data);
      // The server marks the current viewer's row — our heuristic assumes the
      // backend emits that information via an email match in Wave 1; the
      // current-user discovery here is defensive and will be refined in Wave 2.
      const self = data.find((m) => (m as unknown as { self?: boolean }).self === true);
      setCurrentRole(self?.role ?? data[0]?.role ?? null);
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
    void reload();
  }, [reload]);

  const allowManage = useMemo(() => canManage(currentRole), [currentRole]);

  if (!firmId) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-start text-sm text-slate-700">{t('firms.members.missing_firm')}</p>
      </div>
    );
  }

  return (
    <section>
      <header className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-start text-xl font-semibold text-slate-900">
            {t('firms.members.title')}
          </h1>
          <p className="mt-1 text-start text-sm text-slate-600">
            {activeFirm?.name ?? t('firms.members.subtitle_fallback')}
          </p>
        </div>
        {allowManage && (
          <button
            type="button"
            onClick={() => setInviteOpen(true)}
            className="ps-4 pe-4 py-2 rounded-md bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            <span aria-hidden="true" className="me-1">
              +
            </span>
            {t('firms.members.invite')}
          </button>
        )}
      </header>

      {state === 'loading' && (
        <p className="mt-6 text-start text-sm text-slate-600">{t('firms.members.loading')}</p>
      )}
      {state === 'error' && (
        <div
          role="alert"
          className="mt-6 rounded-md border border-rose-200 bg-rose-50 ps-3 pe-3 py-2 text-start text-sm text-rose-900"
        >
          {t('firms.members.load_error')}
        </div>
      )}
      {state === 'unauthenticated' && (
        <div className="mt-6 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <p className="text-start text-sm text-slate-700">{t('firms.members.sign_in')}</p>
        </div>
      )}

      {state === 'ready' && (
        <div className="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          {members.length === 0 ? (
            <p className="text-start text-sm text-slate-600 ps-4 pe-4 py-4">
              {t('firms.members.empty')}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200">
                <thead className="bg-slate-50">
                  <tr>
                    <Th>{t('firms.members.col.email')}</Th>
                    <Th>{t('firms.members.col.role')}</Th>
                    <Th>{t('firms.members.col.status')}</Th>
                    <Th>{t('firms.members.col.joined')}</Th>
                    <Th>&nbsp;</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {members.map((m) => (
                    <tr key={m.userId}>
                      <Td className="font-medium text-slate-900">{m.email}</Td>
                      <Td className="text-slate-700">{t(`firms.role.${m.role}`)}</Td>
                      <Td className="text-slate-700">{t(`firms.members.status.${m.status}`)}</Td>
                      <Td className="text-slate-700">{m.joinedAt ? formatDate(m.joinedAt) : '-'}</Td>
                      <Td className="text-end">
                        {allowManage && m.role !== 'owner' && (
                          <button
                            type="button"
                            onClick={() => setConfirmRemove(m)}
                            className="ps-3 pe-3 py-1.5 rounded-md border border-rose-200 bg-rose-50 text-rose-700 text-sm font-medium hover:bg-rose-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500"
                          >
                            {t('firms.members.remove')}
                          </button>
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {inviteOpen && (
        <InviteModal
          firmId={firmId}
          onClose={() => setInviteOpen(false)}
          onInvited={() => {
            setInviteOpen(false);
            void reload();
          }}
        />
      )}

      {confirmRemove && (
        <RemoveMemberModal
          firmId={firmId}
          member={confirmRemove}
          onClose={() => setConfirmRemove(null)}
          onRemoved={() => {
            setConfirmRemove(null);
            void reload();
          }}
        />
      )}
    </section>
  );
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toISOString().slice(0, 10);
  } catch {
    return iso;
  }
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

interface InviteModalProps {
  firmId: string;
  onClose: () => void;
  onInvited: () => void;
}

function InviteModal({ firmId, onClose, onInvited }: InviteModalProps) {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<FirmMemberRole>('staff');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!email.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await inviteFirmMember(firmId, { email: email.trim(), role });
      onInvited();
    } catch {
      setError(t('firms.members.invite_error'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell title={t('firms.members.invite_title')} onClose={onClose}>
      <form onSubmit={submit} className="mt-4 space-y-4">
        <div>
          <label
            htmlFor="invite-email"
            className="block text-start text-sm font-medium text-slate-800"
          >
            {t('firms.members.invite_email')}
          </label>
          <input
            id="invite-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="mt-1 w-full rounded-md border border-slate-300 bg-white ps-3 pe-3 py-2 text-start text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          />
        </div>
        <div>
          <label
            htmlFor="invite-role"
            className="block text-start text-sm font-medium text-slate-800"
          >
            {t('firms.members.invite_role')}
          </label>
          <select
            id="invite-role"
            value={role}
            onChange={(e) => setRole(e.target.value as FirmMemberRole)}
            className="mt-1 w-full rounded-md border border-slate-300 bg-white ps-3 pe-3 py-2 text-start text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            {FIRM_MEMBER_ROLES.map((r) => (
              <option key={r} value={r}>
                {t(`firms.role.${r}`)}
              </option>
            ))}
          </select>
        </div>
        {error && (
          <div
            role="alert"
            className="rounded-md border border-rose-200 bg-rose-50 ps-3 pe-3 py-2 text-start text-sm text-rose-900"
          >
            {error}
          </div>
        )}
        <div className="flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="ps-4 pe-4 py-2 rounded-md border border-slate-300 bg-white text-slate-800 text-sm font-medium hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            {t('firms.members.cancel')}
          </button>
          <button
            type="submit"
            disabled={!email.trim() || busy}
            className="ps-4 pe-4 py-2 rounded-md bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            {busy ? t('firms.members.sending') : t('firms.members.send_invite')}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

interface RemoveMemberModalProps {
  firmId: string;
  member: FirmMember;
  onClose: () => void;
  onRemoved: () => void;
}

function RemoveMemberModal({ firmId, member, onClose, onRemoved }: RemoveMemberModalProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const doRemove = async () => {
    setBusy(true);
    setError(null);
    try {
      await removeFirmMember(firmId, member.userId);
      onRemoved();
    } catch {
      setError(t('firms.members.remove_error'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell title={t('firms.members.remove_title')} onClose={onClose}>
      <p className="mt-2 text-start text-sm text-slate-700">
        {t('firms.members.remove_confirm', { email: member.email })}
      </p>
      {error && (
        <div
          role="alert"
          className="mt-3 rounded-md border border-rose-200 bg-rose-50 ps-3 pe-3 py-2 text-start text-sm text-rose-900"
        >
          {error}
        </div>
      )}
      <div className="mt-4 flex items-center justify-end gap-3">
        <button
          type="button"
          onClick={onClose}
          className="ps-4 pe-4 py-2 rounded-md border border-slate-300 bg-white text-slate-800 text-sm font-medium hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        >
          {t('firms.members.cancel')}
        </button>
        <button
          type="button"
          onClick={() => void doRemove()}
          disabled={busy}
          className="ps-4 pe-4 py-2 rounded-md bg-rose-600 text-white text-sm font-medium hover:bg-rose-700 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500"
        >
          {busy ? t('firms.members.removing') : t('firms.members.remove')}
        </button>
      </div>
    </ModalShell>
  );
}

interface ModalShellProps {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}

function ModalShell({ title, onClose, children }: ModalShellProps) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
      className="fixed inset-0 z-30 flex items-center justify-center bg-slate-900/50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl">
        <h2 id="modal-title" className="text-start text-base font-semibold text-slate-900">
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}

export default FirmMembersPage;
