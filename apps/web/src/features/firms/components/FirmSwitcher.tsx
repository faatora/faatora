import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { useFirmContext } from '../context/FirmContext';

export function FirmSwitcher() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { activeFirm, firmList, switchFirm } = useFirmContext();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (ev: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(ev.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const label = activeFirm?.name ?? t('firms.switcher.chooseFirm');

  const choose = (firmId: string) => {
    switchFirm(firmId);
    setOpen(false);
    navigate(`/firms/${firmId}/dashboard`);
  };

  return (
    <div ref={rootRef} className="relative inline-block text-start">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('firms.switcher.aria')}
        className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white ps-3 pe-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
      >
        <span
          aria-hidden="true"
          className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-indigo-100 text-indigo-700 text-xs font-semibold"
        >
          {(activeFirm?.name?.[0] ?? '?').toUpperCase()}
        </span>
        <span className="truncate max-w-[12rem]">{label}</span>
        <span aria-hidden="true" className="ms-1 text-slate-500">
          {open ? '▲' : '▼'}
        </span>
      </button>

      {open && (
        <div
          role="menu"
          aria-label={t('firms.switcher.aria')}
          className="absolute end-0 mt-2 w-72 rounded-md border border-slate-200 bg-white shadow-lg ring-1 ring-black/5 focus:outline-none z-20"
        >
          <div className="ps-3 pe-3 py-2 text-start text-xs font-semibold uppercase tracking-wide text-slate-500">
            {t('firms.switcher.your_firms')}
          </div>
          {firmList.length === 0 ? (
            <p className="ps-3 pe-3 py-2 text-start text-sm text-slate-600">
              {t('firms.switcher.empty')}
            </p>
          ) : (
            <ul className="max-h-64 overflow-y-auto py-1">
              {firmList.map((m) => {
                const isActive = activeFirm?.id === m.firm.id;
                return (
                  <li key={m.firm.id}>
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={isActive}
                      onClick={() => choose(m.firm.id)}
                      className={`flex w-full items-center justify-between ps-3 pe-3 py-2 text-start text-sm hover:bg-slate-50 focus:outline-none focus-visible:bg-slate-50 ${
                        isActive ? 'bg-indigo-50 text-indigo-800' : 'text-slate-800'
                      }`}
                    >
                      <span className="truncate">{m.firm.name}</span>
                      {isActive && (
                        <span
                          aria-hidden="true"
                          className="ms-2 inline-flex items-center rounded-full bg-indigo-100 ps-2 pe-2 py-0.5 text-xs font-semibold text-indigo-800"
                        >
                          {t('firms.switcher.active')}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="border-t border-slate-100" />
          <div className="py-1">
            <Link
              to="/firms/new"
              onClick={() => setOpen(false)}
              className="block ps-3 pe-3 py-2 text-start text-sm text-slate-800 hover:bg-slate-50"
              role="menuitem"
            >
              <span aria-hidden="true" className="me-2">
                +
              </span>
              {t('firms.switcher.create')}
            </Link>
            <Link
              to="/firms/invitations/accept"
              onClick={() => setOpen(false)}
              className="block ps-3 pe-3 py-2 text-start text-sm text-slate-800 hover:bg-slate-50"
              role="menuitem"
            >
              <span aria-hidden="true" className="me-2">
                {'✉'}
              </span>
              {t('firms.switcher.accept_invitation')}
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

export default FirmSwitcher;
