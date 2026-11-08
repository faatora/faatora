import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { UnauthorizedError } from '../../../lib/api';
import { createFirm } from '../api';
import { useFirmContext } from '../context/FirmContext';
import type { CreateFirmInput } from '../types';

type Field = keyof CreateFirmInput;

export function FirmBootstrapPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { switchFirm, refreshFirms } = useFirmContext();

  const [values, setValues] = useState<CreateFirmInput>({
    name: '',
    legal_name: '',
    cr_number: '',
    vatin: '',
    email: '',
    phone: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = (field: Field) => (ev: React.ChangeEvent<HTMLInputElement>) =>
    setValues((v) => ({ ...v, [field]: ev.target.value }));

  const canSubmit =
    values.name.trim().length > 0 &&
    values.legal_name.trim().length > 0 &&
    values.cr_number.trim().length > 0 &&
    values.email.trim().length > 0 &&
    values.phone.trim().length > 0 &&
    !busy;

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const payload: CreateFirmInput = {
        name: values.name.trim(),
        legal_name: values.legal_name.trim(),
        cr_number: values.cr_number.trim(),
        email: values.email.trim(),
        phone: values.phone.trim(),
      };
      if (values.vatin && values.vatin.trim().length > 0) {
        payload.vatin = values.vatin.trim();
      }
      const firm = await createFirm(payload);
      // Refresh membership list, then switch into the new firm and head to its dashboard.
      await refreshFirms();
      switchFirm(firm.id);
      navigate(`/firms/${firm.id}/dashboard`);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        setError(t('firms.bootstrap.unauthorized'));
      } else {
        setError(t('firms.bootstrap.error'));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <h1 className="text-start text-xl font-semibold text-slate-900">
        {t('firms.bootstrap.title')}
      </h1>
      <p className="mt-2 text-start text-sm text-slate-700">{t('firms.bootstrap.subtitle')}</p>

      <form onSubmit={submit} noValidate className="mt-6 space-y-4">
        <TextField
          id="firm-name"
          label={t('firms.bootstrap.name')}
          value={values.name}
          onChange={update('name')}
          required
        />
        <TextField
          id="firm-legal-name"
          label={t('firms.bootstrap.legal_name')}
          value={values.legal_name}
          onChange={update('legal_name')}
          required
        />
        <TextField
          id="firm-cr"
          label={t('firms.bootstrap.cr_number')}
          value={values.cr_number}
          onChange={update('cr_number')}
          required
        />
        <TextField
          id="firm-vatin"
          label={t('firms.bootstrap.vatin')}
          value={values.vatin ?? ''}
          onChange={update('vatin')}
          hint={t('firms.bootstrap.vatin_hint')}
        />
        <TextField
          id="firm-email"
          label={t('firms.bootstrap.email')}
          type="email"
          value={values.email}
          onChange={update('email')}
          required
        />
        <TextField
          id="firm-phone"
          label={t('firms.bootstrap.phone')}
          value={values.phone}
          onChange={update('phone')}
          required
        />

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
            onClick={() => navigate(-1)}
            className="ps-4 pe-4 py-2 rounded-md border border-slate-300 bg-white text-slate-800 text-sm font-medium hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            {t('firms.bootstrap.cancel')}
          </button>
          <button
            type="submit"
            disabled={!canSubmit}
            className="ps-5 pe-5 py-2 rounded-md bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            {busy ? t('firms.bootstrap.submitting') : t('firms.bootstrap.submit')}
          </button>
        </div>
      </form>
    </section>
  );
}

interface TextFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (ev: React.ChangeEvent<HTMLInputElement>) => void;
  hint?: string;
  type?: string;
  required?: boolean;
}

function TextField({ id, label, value, onChange, hint, type = 'text', required }: TextFieldProps) {
  return (
    <div>
      <label htmlFor={id} className="block text-start text-sm font-medium text-slate-800">
        {label}
        {required && (
          <span aria-hidden="true" className="ms-1 text-rose-600">
            *
          </span>
        )}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={onChange}
        required={required}
        className="mt-1 w-full rounded-md border border-slate-300 bg-white ps-3 pe-3 py-2 text-start text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
      />
      {hint && <p className="mt-1 text-start text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

export default FirmBootstrapPage;
