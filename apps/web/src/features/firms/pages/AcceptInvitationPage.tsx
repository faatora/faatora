import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { UnauthorizedError } from '../../../lib/api';
import { acceptInvitation } from '../api';
import { useFirmContext } from '../context/FirmContext';

type State = 'idle' | 'accepting' | 'error' | 'unauthenticated' | 'missing_token';

export function AcceptInvitationPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { switchFirm, refreshFirms } = useFirmContext();
  const token = params.get('token');
  const [state, setState] = useState<State>('idle');
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    if (!token) {
      setState('missing_token');
      return;
    }
    setState('accepting');
    setError(null);
    try {
      const { firmId } = await acceptInvitation(token);
      await refreshFirms();
      switchFirm(firmId);
      navigate(`/firms/${firmId}/dashboard`);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        setState('unauthenticated');
        return;
      }
      setState('error');
      setError(t('firms.accept.error'));
    }
  }, [token, refreshFirms, switchFirm, navigate, t]);

  useEffect(() => {
    void run();
  }, [run]);

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <h1 className="text-start text-xl font-semibold text-slate-900">{t('firms.accept.title')}</h1>

      {state === 'missing_token' && (
        <div
          role="alert"
          className="mt-4 rounded-md border border-amber-200 bg-amber-50 ps-3 pe-3 py-2 text-start text-sm text-amber-900"
        >
          {t('firms.accept.missing_token')}
        </div>
      )}

      {state === 'accepting' && (
        <p className="mt-4 text-start text-sm text-slate-700">{t('firms.accept.accepting')}</p>
      )}

      {state === 'unauthenticated' && (
        <p className="mt-4 text-start text-sm text-slate-700">{t('firms.accept.sign_in')}</p>
      )}

      {state === 'error' && (
        <>
          <div
            role="alert"
            className="mt-4 rounded-md border border-rose-200 bg-rose-50 ps-3 pe-3 py-2 text-start text-sm text-rose-900"
          >
            {error}
          </div>
          <div className="mt-4 flex items-center gap-3">
            <button
              type="button"
              onClick={() => void run()}
              className="ps-4 pe-4 py-2 rounded-md bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            >
              {t('firms.accept.retry')}
            </button>
            <button
              type="button"
              onClick={() => navigate('/')}
              className="ps-4 pe-4 py-2 rounded-md border border-slate-300 bg-white text-slate-800 text-sm font-medium hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            >
              {t('firms.accept.back')}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

export default AcceptInvitationPage;
