import { useEffect, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

type DirectionProviderProps = {
  children: ReactNode;
};

export function DirectionProvider({ children }: DirectionProviderProps) {
  const { i18n } = useTranslation();
  const language = i18n.language;

  useEffect(() => {
    const root = document.documentElement;
    const base = (language || 'en').split('-')[0];
    const dir = base === 'ar' ? 'rtl' : 'ltr';
    root.setAttribute('dir', dir);
    root.setAttribute('lang', base);
  }, [language]);

  return <>{children}</>;
}

export default DirectionProvider;
