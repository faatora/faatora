import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  submitChecker,
  CheckerSubmitError,
  type B2CShare,
  type CheckerInput,
  type InvoiceVolumeBand,
  type ReadinessVerdict,
  type RevenueBand,
} from './api';
import { ResultView } from './ResultView';

const TOTAL_STEPS = 12;

const REVENUE_BANDS: RevenueBand[] = ['<=100k', '100k-500k', '500k-1M', '1M-5M', '>5M'];
const VOLUME_BANDS: InvoiceVolumeBand[] = ['<100', '100-500', '500-2000', '>2000'];
const B2C_SHARES: B2CShare[] = ['0', '<25', '25-50', '>50'];
const TOOL_PRESETS = ['excel', 'tally', 'zohoBooks', 'quickBooks', 'odoo', 'other'] as const;
const ERP_PRESETS = ['sap', 'oracle', 'odoo', 'none', 'other'] as const;

const PHONE_RE = /^\+?968?\s?\d{4}\s?\d{4}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type FormState = {
  fullName: string;
  companyName: string;
  email: string;
  phone: string;
  vatRegistered: boolean | null;
  revenueBand: RevenueBand | '';
  currentTool: string;
  invoiceVolumeBand: InvoiceVolumeBand | '';
  b2cShare: B2CShare | '';
  erp: string;
};

const emptyForm = (): FormState => ({
  fullName: '',
  companyName: '',
  email: '',
  phone: '',
  vatRegistered: null,
  revenueBand: '',
  currentTool: '',
  invoiceVolumeBand: '',
  b2cShare: '',
  erp: '',
});

function isStepValid(step: number, form: FormState): boolean {
  switch (step) {
    case 1:
      return form.fullName.trim().length > 0;
    case 2:
      return form.companyName.trim().length > 0;
    case 3:
      return EMAIL_RE.test(form.email.trim());
    case 4:
      return PHONE_RE.test(form.phone.trim());
    case 5:
      return form.vatRegistered !== null;
    case 6:
      return form.revenueBand !== '';
    case 7:
      return form.currentTool.trim().length > 0;
    case 8:
      return form.invoiceVolumeBand !== '';
    case 9:
      return form.b2cShare !== '';
    case 10:
      return true; // optional
    case 11:
    case 12:
      return (
        isStepValid(1, form) &&
        isStepValid(2, form) &&
        isStepValid(3, form) &&
        isStepValid(4, form) &&
        isStepValid(5, form) &&
        isStepValid(6, form) &&
        isStepValid(7, form) &&
        isStepValid(8, form) &&
        isStepValid(9, form)
      );
    default:
      return false;
  }
}

function buildInput(form: FormState): CheckerInput {
  return {
    fullName: form.fullName.trim(),
    companyName: form.companyName.trim(),
    email: form.email.trim(),
    phone: form.phone.trim(),
    vatRegistered: form.vatRegistered === true,
    revenueBand: form.revenueBand as RevenueBand,
    currentTool: form.currentTool.trim(),
    invoiceVolumeBand: form.invoiceVolumeBand as InvoiceVolumeBand,
    b2cShare: form.b2cShare as B2CShare,
    erp: form.erp.trim() ? form.erp.trim() : undefined,
  };
}

export function CheckerPage() {
  const { t } = useTranslation();
  const [step, setStep] = useState(1);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<ReadinessVerdict | null>(null);

  const canAdvance = useMemo(() => isStepValid(step, form), [step, form]);

  if (verdict) {
    return (
      <div className="mx-auto max-w-3xl">
        <h1 className="text-start text-2xl font-bold text-slate-900">{t('checker.title')}</h1>
        <p className="mt-1 text-start text-sm text-slate-600">{t('checker.subtitle')}</p>
        <div className="mt-6">
          <ResultView
            verdict={verdict}
            onRestart={() => {
              setForm(emptyForm());
              setStep(1);
              setVerdict(null);
              setSubmitError(null);
            }}
          />
        </div>
      </div>
    );
  }

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
  };

  const goNext = () => {
    if (!canAdvance) return;
    setStep((s) => Math.min(TOTAL_STEPS, s + 1));
  };

  const goBack = () => {
    setStep((s) => Math.max(1, s - 1));
  };

  const handleSubmit = async () => {
    if (!canAdvance) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await submitChecker(buildInput(form));
      setVerdict(result.verdict);
    } catch (err) {
      if (err instanceof CheckerSubmitError) {
        setSubmitError(t('checker.submitError'));
      } else {
        setSubmitError(t('checker.submitError'));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const progressPct = Math.round(((step - 1) / (TOTAL_STEPS - 1)) * 100);

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-start text-2xl font-bold text-slate-900">{t('checker.title')}</h1>
      <p className="mt-1 text-start text-sm text-slate-600">{t('checker.subtitle')}</p>

      <div className="mt-6 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-slate-600">
            {t('checker.step', { step, total: TOTAL_STEPS })}
          </span>
          <span className="text-xs text-slate-500" aria-hidden="true">
            {progressPct}%
          </span>
        </div>
        <div
          className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-100"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progressPct}
        >
          <div
            className="h-full bg-indigo-600 transition-[width] duration-300"
            style={{ width: `${progressPct}%` }}
          />
        </div>

        <div className="mt-6 min-h-[12rem]">
          <StepBody step={step} form={form} update={update} />
        </div>

        {submitError && (
          <div
            role="alert"
            className="mt-4 rounded-md border border-rose-200 bg-rose-50 ps-3 pe-3 py-2 text-start text-sm text-rose-900"
          >
            {submitError}
          </div>
        )}

        <div className="mt-6 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={goBack}
            disabled={step === 1 || submitting}
            className="ps-5 pe-5 py-2 rounded-md border border-slate-300 bg-white text-slate-700 font-medium hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            {t('checker.back')}
          </button>
          {step < TOTAL_STEPS ? (
            <button
              type="button"
              onClick={goNext}
              disabled={!canAdvance}
              className="ps-5 pe-5 py-2 rounded-md bg-indigo-600 text-white font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            >
              {t('checker.next')}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={!canAdvance || submitting}
              className="ps-5 pe-5 py-2 rounded-md bg-indigo-600 text-white font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            >
              {submitting ? t('checker.submitting') : t('checker.submit')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

type StepBodyProps = {
  step: number;
  form: FormState;
  update: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
};

function StepBody({ step, form, update }: StepBodyProps) {
  const { t } = useTranslation();

  const labelCls = 'block text-start text-base font-semibold text-slate-900';
  const hintCls = 'mt-1 text-start text-xs text-slate-500';
  const inputCls =
    'mt-3 w-full rounded-md border border-slate-300 bg-white ps-3 pe-3 py-2 text-start text-slate-900 placeholder:text-slate-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500';

  const radioRow = 'flex items-start rounded-md border border-slate-200 bg-white ps-3 pe-3 py-2';
  const radioInput = 'me-3 mt-0.5 h-4 w-4 accent-indigo-600';
  const radioText = 'text-start text-sm text-slate-800';

  switch (step) {
    case 1:
      return (
        <div>
          <label htmlFor="fullName" className={labelCls}>
            {t('checker.q1_fullName')}
          </label>
          <input
            id="fullName"
            type="text"
            autoComplete="name"
            value={form.fullName}
            onChange={(e) => update('fullName', e.target.value)}
            className={inputCls}
          />
        </div>
      );
    case 2:
      return (
        <div>
          <label htmlFor="companyName" className={labelCls}>
            {t('checker.q2_companyName')}
          </label>
          <input
            id="companyName"
            type="text"
            autoComplete="organization"
            value={form.companyName}
            onChange={(e) => update('companyName', e.target.value)}
            className={inputCls}
          />
        </div>
      );
    case 3:
      return (
        <div>
          <label htmlFor="email" className={labelCls}>
            {t('checker.q3_email')}
          </label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            inputMode="email"
            value={form.email}
            onChange={(e) => update('email', e.target.value)}
            className={inputCls}
          />
        </div>
      );
    case 4:
      return (
        <div>
          <label htmlFor="phone" className={labelCls}>
            {t('checker.q4_phone')}
          </label>
          <p className={hintCls}>{t('checker.q4_phoneHint')}</p>
          <input
            id="phone"
            type="tel"
            autoComplete="tel"
            inputMode="tel"
            dir="ltr"
            placeholder="+968 9123 4567"
            value={form.phone}
            onChange={(e) => update('phone', e.target.value)}
            className={inputCls}
          />
        </div>
      );
    case 5:
      return (
        <fieldset>
          <legend className={labelCls}>{t('checker.q5_vatRegistered')}</legend>
          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {[
              { v: true, k: 'yes' as const },
              { v: false, k: 'no' as const },
            ].map(({ v, k }) => (
              <label key={k} className={radioRow}>
                <input
                  type="radio"
                  name="vatRegistered"
                  checked={form.vatRegistered === v}
                  onChange={() => update('vatRegistered', v)}
                  className={radioInput}
                />
                <span className={radioText}>{t(`checker.${k}`)}</span>
              </label>
            ))}
          </div>
        </fieldset>
      );
    case 6:
      return (
        <fieldset>
          <legend className={labelCls}>{t('checker.q6_revenue')}</legend>
          <div className="mt-3 grid grid-cols-1 gap-2">
            {REVENUE_BANDS.map((band) => (
              <label key={band} className={radioRow}>
                <input
                  type="radio"
                  name="revenueBand"
                  checked={form.revenueBand === band}
                  onChange={() => update('revenueBand', band)}
                  className={radioInput}
                />
                <span className={radioText}>{t(`checker.revenue.${band}`)}</span>
              </label>
            ))}
          </div>
        </fieldset>
      );
    case 7:
      return (
        <div>
          <label htmlFor="currentTool" className={labelCls}>
            {t('checker.q7_currentTool')}
          </label>
          <p className={hintCls}>{t('checker.q7_currentToolHint')}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {TOOL_PRESETS.map((p) => {
              const label = t(`checker.tool.${p}`);
              const active = form.currentTool === label;
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => update('currentTool', label)}
                  className={`ps-3 pe-3 py-1.5 rounded-full border text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
                    active
                      ? 'bg-indigo-600 text-white border-indigo-600'
                      : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <input
            id="currentTool"
            type="text"
            value={form.currentTool}
            onChange={(e) => update('currentTool', e.target.value)}
            className={inputCls}
          />
        </div>
      );
    case 8:
      return (
        <fieldset>
          <legend className={labelCls}>{t('checker.q8_volume')}</legend>
          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {VOLUME_BANDS.map((v) => (
              <label key={v} className={radioRow}>
                <input
                  type="radio"
                  name="invoiceVolumeBand"
                  checked={form.invoiceVolumeBand === v}
                  onChange={() => update('invoiceVolumeBand', v)}
                  className={radioInput}
                />
                <span className={radioText}>{t(`checker.volume.${v}`)}</span>
              </label>
            ))}
          </div>
        </fieldset>
      );
    case 9:
      return (
        <fieldset>
          <legend className={labelCls}>{t('checker.q9_b2c')}</legend>
          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {B2C_SHARES.map((v) => (
              <label key={v} className={radioRow}>
                <input
                  type="radio"
                  name="b2cShare"
                  checked={form.b2cShare === v}
                  onChange={() => update('b2cShare', v)}
                  className={radioInput}
                />
                <span className={radioText}>{t(`checker.b2c.${v}`)}</span>
              </label>
            ))}
          </div>
        </fieldset>
      );
    case 10:
      return (
        <div>
          <label htmlFor="erp" className={labelCls}>
            {t('checker.q10_erp')}
          </label>
          <div className="mt-3 flex flex-wrap gap-2">
            {ERP_PRESETS.map((p) => {
              const label = t(`checker.erp.${p}`);
              const active = form.erp === label;
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => update('erp', active ? '' : label)}
                  className={`ps-3 pe-3 py-1.5 rounded-full border text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
                    active
                      ? 'bg-indigo-600 text-white border-indigo-600'
                      : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <input
            id="erp"
            type="text"
            value={form.erp}
            onChange={(e) => update('erp', e.target.value)}
            className={inputCls}
          />
        </div>
      );
    case 11:
      return <ReviewPanel form={form} />;
    case 12:
      return <ConfirmPanel form={form} />;
    default:
      return null;
  }
}

function ReviewPanel({ form }: { form: FormState }) {
  const { t } = useTranslation();

  const rows: Array<{ label: string; value: string }> = [
    { label: t('checker.q1_fullName'), value: form.fullName },
    { label: t('checker.q2_companyName'), value: form.companyName },
    { label: t('checker.q3_email'), value: form.email },
    { label: t('checker.q4_phone'), value: form.phone },
    {
      label: t('checker.q5_vatRegistered'),
      value:
        form.vatRegistered === null ? '' : form.vatRegistered ? t('checker.yes') : t('checker.no'),
    },
    {
      label: t('checker.q6_revenue'),
      value: form.revenueBand ? t(`checker.revenue.${form.revenueBand}`) : '',
    },
    { label: t('checker.q7_currentTool'), value: form.currentTool },
    {
      label: t('checker.q8_volume'),
      value: form.invoiceVolumeBand ? t(`checker.volume.${form.invoiceVolumeBand}`) : '',
    },
    {
      label: t('checker.q9_b2c'),
      value: form.b2cShare ? t(`checker.b2c.${form.b2cShare}`) : '',
    },
    { label: t('checker.q10_erp'), value: form.erp || '—' },
  ];

  return (
    <div>
      <h2 className="text-start text-base font-semibold text-slate-900">
        {t('checker.q11_review')}
      </h2>
      <dl className="mt-3 divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
        {rows.map((row) => (
          <div key={row.label} className="grid grid-cols-1 gap-1 ps-3 pe-3 py-2 sm:grid-cols-3">
            <dt className="text-start text-xs font-medium uppercase tracking-wide text-slate-500 sm:col-span-1">
              {row.label}
            </dt>
            <dd className="text-start text-sm text-slate-900 sm:col-span-2">{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function ConfirmPanel({ form }: { form: FormState }) {
  const { t } = useTranslation();
  return (
    <div className="text-start">
      <h2 className="text-base font-semibold text-slate-900">{t('checker.q12_confirmTitle')}</h2>
      <p className="mt-2 text-sm text-slate-600">
        {t('checker.q12_confirmBody', { email: form.email || '—' })}
      </p>
    </div>
  );
}

export default CheckerPage;
