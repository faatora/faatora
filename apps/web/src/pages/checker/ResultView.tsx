import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ReadinessVerdict } from './api';

type ResultViewProps = {
  verdict: ReadinessVerdict;
  onRestart?: () => void;
};

export function ResultView({ verdict, onRestart }: ResultViewProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const readyTitle = verdict.ready
    ? t('checker.result.readyTitle')
    : t('checker.result.notReadyTitle');

  const deadlineLabel =
    verdict.deadline === '2027-04-01'
      ? t('checker.result.deadlineApr')
      : t('checker.result.deadlineOct');

  const badgeTone = verdict.ready
    ? 'bg-emerald-100 text-emerald-800 border-emerald-200'
    : 'bg-amber-100 text-amber-800 border-amber-200';

  const handleShare = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore clipboard failures silently
    }
  };

  return (
    <section
      aria-live="polite"
      className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
    >
      <div
        className={`inline-flex items-center rounded-full border px-4 py-1 text-sm font-semibold ${badgeTone}`}
      >
        {readyTitle}
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-start">
          <div className="text-xs uppercase tracking-wide text-slate-500">
            {t('checker.result.score')}
          </div>
          <div className="mt-1 text-3xl font-bold text-slate-900">{verdict.score}</div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-start">
          <div className="text-xs uppercase tracking-wide text-slate-500">
            {t('checker.result.deadline')}
          </div>
          <div className="mt-1 text-lg font-semibold text-slate-900">{deadlineLabel}</div>
        </div>
      </div>

      {verdict.blockers.length > 0 && (
        <div className="mt-6">
          <h3 className="text-start text-base font-semibold text-slate-900">
            {t('checker.result.blockers')}
          </h3>
          <ul className="mt-2 space-y-2">
            {verdict.blockers.map((b) => (
              <li
                key={b}
                className="flex items-start rounded-md border border-rose-200 bg-rose-50 ps-3 pe-3 py-2 text-start text-sm text-rose-900"
              >
                <span aria-hidden="true" className="me-2 mt-0.5">
                  !
                </span>
                <span>{b}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {verdict.recommendations.length > 0 && (
        <div className="mt-6">
          <h3 className="text-start text-base font-semibold text-slate-900">
            {t('checker.result.recommendations')}
          </h3>
          <ul className="mt-2 space-y-2">
            {verdict.recommendations.map((r) => (
              <li
                key={r}
                className="flex items-start rounded-md border border-sky-200 bg-sky-50 ps-3 pe-3 py-2 text-start text-sm text-sky-900"
              >
                <span aria-hidden="true" className="me-2 mt-0.5">
                  →
                </span>
                <span>{r}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-8 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void handleShare()}
          className="ps-5 pe-5 py-2 rounded-md bg-indigo-600 text-white font-medium hover:bg-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        >
          {t('checker.result.share')}
        </button>
        {copied && (
          <span className="text-sm text-emerald-700" role="status">
            {t('checker.result.shareCopied')}
          </span>
        )}
        {onRestart && (
          <button
            type="button"
            onClick={onRestart}
            className="ps-5 pe-5 py-2 rounded-md border border-slate-300 bg-white text-slate-700 font-medium hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            {t('checker.result.restart')}
          </button>
        )}
      </div>
    </section>
  );
}

export default ResultView;
