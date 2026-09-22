import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createI18n, initialLanguage, LANGUAGE_STORAGE_KEY, type Language } from './localization';

const LanguageContext = createContext({ ...createI18n(initialLanguage()), setLanguage: (_language: Language) => {} });

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState<Language>(() => {
    try { return initialLanguage(window.localStorage); } catch { return initialLanguage(); }
  });
  useEffect(() => {
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
    try { window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language); } catch { /* Still switch when storage is blocked. */ }
  }, [language]);
  const value = useMemo(() => ({ ...createI18n(language), setLanguage }), [language]);
  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useI18n() { return useContext(LanguageContext); }

export function LanguageSwitch() {
  const { language, setLanguage } = useI18n();
  return <button type="button" className="language-switch" aria-label={language === 'zh' ? '切换为英文' : 'Switch to Chinese'}
    onClick={() => setLanguage(language === 'zh' ? 'en' : 'zh')}>
    <span lang={language === 'zh' ? 'en' : 'zh-CN'}>{language === 'zh' ? 'English' : '中文'}</span>
  </button>;
}
