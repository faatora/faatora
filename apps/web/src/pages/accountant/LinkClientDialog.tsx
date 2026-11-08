import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AccountantUnauthorizedError, linkTenant } from './api';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface LinkClientDialogProps {
  open: boolean;
  onClose: () => void;
  onLinked: () => void;
}

export function LinkClientDialog({ open, onClose, onLinked }: LinkClientDialogProps) {
  const { t } = useTranslation();
  const [tenantId, setTenantId] = useState('');
  const [referred, setReferred] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setTenantId('');
      setReferred(false);
      setError(null);
      // Focus the first input on open for a11y
      setTimeout(() => firstInputRef.current?.focus(), 0);
    }
  }, [open]);

  if (!open) return null;

  const valid = UUID_RE.test(tenantId.trim());

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await linkTenant(tenantId.trim(), { referred });
      onLinked();
      onClose();
    } catch (err) {
      if (err instanceof AccountantUnauthorizedError) {
        setError(t('accountant.pleaseLogIn'));
      } else {
        setError(t('accountant.linkError'));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="link-client-title"
      className="fixed inset-0 z-20 flex items-center justify-center bg-slate-900/50 px-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-lg">
        <h2 id="link-client-title" className="text-start text-lg font-semibold text-slate-900">
          {t('accountant.link_client')}
        </h2>
        <p className="mt-1 text-start text-sm text-slate-600">{t('accountant.link_client_hint')}</p>

        <label
          htmlFor="link-tenant-id"
          className="mt-5 block text-start text-sm font-medium text-slate-800"
        >
          {t('accountant.tenant_id')}
        </label>
        <input
          id="link-tenant-id"
          ref={firstInputRef}
          type="text"
          dir="ltr"
          autoComplete="off"
          value={tenantId}
          onChange={(e) => setTenantId(e.target.value)}
          placeholder="00000000-0000-0000-0000-000000000000"
          className="mt-2 w-full rounded-md border border-slate-300 bg-white ps-3 pe-3 py-2 text-start text-slate-900 placeholder:text-slate-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        />

        <label className="mt-4 flex items-center">
          <input
            type="checkbox"
            checked={referred}
            onChange={(e) => setReferred(e.target.checked)}
            className="me-2 h-4 w-4 accent-indigo-600"
          />
          <span className="text-start text-sm text-slate-800">{t('accountant.mark_referred')}</span>
        </label>

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
            onClick={onClose}
            disabled={busy}
            className="ps-4 pe-4 py-2 rounded-md border border-slate-300 bg-white text-slate-700 font-medium hover:bg-slate-50 disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            {t('accountant.cancel')}
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!valid || busy}
            className="ps-4 pe-4 py-2 rounded-md bg-indigo-600 text-white font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            {busy ? t('accountant.linking') : t('accountant.link')}
          </button>
        </div>
      </div>
    </div>
  );
}

export default LinkClientDialog;
