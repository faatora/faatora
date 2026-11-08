import { useTranslation } from 'react-i18next';

export function LanguageToggle() {
  const { i18n, t } = useTranslation();
  const current = (i18n.language || 'en').split('-')[0];

  const change = (lng: 'en' | 'ar') => {
    void i18n.changeLanguage(lng);
  };

  const baseBtn =
    'px-3 py-1.5 text-sm font-medium rounded-md border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500';
  const active = 'bg-indigo-600 text-white border-indigo-600';
  const idle = 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50';

  return (
    <div className="inline-flex items-center gap-2" role="group" aria-label="Language">
      <button
        type="button"
        onClick={() => change('en')}
        aria-pressed={current === 'en'}
        className={`${baseBtn} ${current === 'en' ? active : idle}`}
      >
        {t('nav.en')}
      </button>
      <button
        type="button"
        onClick={() => change('ar')}
        aria-pressed={current === 'ar'}
        className={`${baseBtn} ${current === 'ar' ? active : idle}`}
      >
        {t('nav.ar')}
      </button>
    </div>
  );
}

export default LanguageToggle;
