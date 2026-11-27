import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useFirmContext } from '../context/FirmContext';

/**
 * Persistent banner that renders above every console view while the
 * current user is "acting as" one of their firm's client tenants. The
 * banner is deliberately loud (amber, high contrast) because the
 * impersonating user is about to write under someone else's name.
 *
 * Clicking "Exit" clears the impersonation key and returns the user to
 * the firm's client list so the context switch is obvious; if no firm
 * is currently active we send them home instead.
 */
export function ImpersonationBanner() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { impersonatingTenantId, stopActingAs, activeFirm } = useFirmContext();

  const clientLabel = useMemo(() => impersonatingTenantId ?? '', [impersonatingTenantId]);

  if (!impersonatingTenantId) return null;

  const exit = () => {
    stopActingAs();
    if (activeFirm?.id) {
      navigate(`/firms/${activeFirm.id}/clients`);
    } else {
      navigate('/');
    }
  };

  return (
    <div
      role="status"
      aria-live="polite"
      className="sticky top-0 z-30 border-b border-amber-300 bg-amber-100 text-amber-900"
      data-testid="impersonation-banner"
    >
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-6 py-2">
        <p className="min-w-0 truncate text-start text-sm font-medium">
          <span aria-hidden="true" className="me-2">
            ⚠
          </span>
          {t('impersonation.banner', { client: clientLabel })}
        </p>
        <button
          type="button"
          onClick={exit}
          className="shrink-0 rounded-md border border-amber-400 bg-white ps-3 pe-3 py-1 text-xs font-semibold text-amber-900 hover:bg-amber-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
        >
          {t('impersonation.exit')}
        </button>
      </div>
    </div>
  );
}

export default ImpersonationBanner;
