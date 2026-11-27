import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../../lib/api';
import { InvalidCredentialsError, login } from '../../features/auth/api/auth';

/**
 * POS-focused login page. A shop clerk opens this on a tablet, enters
 * the credentials the shop owner provisioned for them, and is dropped
 * straight into `/pos`. The form mirrors the shape of the firm bootstrap
 * form so every console in the app feels like the same product.
 *
 * On success: token + tenant id are written into localStorage by the
 * `login()` helper, which is all `apps/web/src/pages/pos/api.ts` needs
 * to pick them up on its next request.
 *
 * On failure: the inline error renders in-place and the email/password
 * fields are preserved so the clerk can correct a typo.
 */
export function PosLoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = email.trim().length > 0 && password.length > 0 && !busy;

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await login({ email: email.trim(), password });
      navigate('/pos', { replace: true });
    } catch (err) {
      if (err instanceof InvalidCredentialsError) {
        setError(t('pos.login.errorCredentials'));
      } else if (err instanceof ApiError) {
        setError(t('pos.login.errorNetwork'));
      } else {
        setError(t('pos.login.error'));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="min-h-screen bg-slate-50">
      <div className="mx-auto max-w-sm px-6 py-16">
        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h1 className="text-start text-xl font-semibold text-slate-900">
            {t('pos.login.title')}
          </h1>
          <p className="mt-1 text-start text-sm text-slate-600">{t('pos.login.subtitle')}</p>

          <form onSubmit={submit} noValidate className="mt-5 space-y-4">
            <div>
              <label
                htmlFor="pos-login-email"
                className="block text-start text-sm font-medium text-slate-800"
              >
                {t('pos.login.email')}
                <span aria-hidden="true" className="ms-1 text-rose-600">
                  *
                </span>
              </label>
              <input
                id="pos-login-email"
                name="email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(ev) => setEmail(ev.target.value)}
                required
                className="mt-1 w-full rounded-md border border-slate-300 bg-white ps-3 pe-3 py-2 text-start text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
              />
            </div>

            <div>
              <label
                htmlFor="pos-login-password"
                className="block text-start text-sm font-medium text-slate-800"
              >
                {t('pos.login.password')}
                <span aria-hidden="true" className="ms-1 text-rose-600">
                  *
                </span>
              </label>
              <input
                id="pos-login-password"
                name="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(ev) => setPassword(ev.target.value)}
                required
                className="mt-1 w-full rounded-md border border-slate-300 bg-white ps-3 pe-3 py-2 text-start text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
              />
            </div>

            {error && (
              <div
                role="alert"
                className="rounded-md border border-rose-200 bg-rose-50 ps-3 pe-3 py-2 text-start text-sm text-rose-900"
              >
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={!canSubmit}
              className="w-full rounded-md bg-indigo-600 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            >
              {busy ? t('pos.login.submitting') : t('pos.login.submit')}
            </button>
          </form>
        </section>
      </div>
    </main>
  );
}

export default PosLoginPage;
