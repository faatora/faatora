import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BrowserRouter,
  Link,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom';
import { DirectionProvider } from './components/DirectionProvider';
import { LanguageToggle } from './components/LanguageToggle';
import { CheckerPage } from './pages/checker/CheckerPage';
import { PosPage } from './pages/pos/PosPage';
import { AccountantPage } from './pages/accountant/AccountantPage';
import { FirmContextProvider, useFirmContext } from './features/firms/context/FirmContext';
import { FirmSwitcher } from './features/firms/components/FirmSwitcher';
import { FirmBootstrapPage } from './features/firms/pages/FirmBootstrapPage';
import { FirmMembersPage } from './features/firms/pages/FirmMembersPage';
import { AcceptInvitationPage } from './features/firms/pages/AcceptInvitationPage';
import { DashboardPage } from './features/firms/dashboard/pages/DashboardPage';
import { ImportWizardPage } from './features/imports/pages/ImportWizardPage';

type HashRoute = 'checker' | 'pos' | 'accountant' | 'landing' | null;

// Preserves the pre-pivot hash routing so no existing SME-mode link breaks.
function readHashRoute(): HashRoute {
  if (typeof window === 'undefined') return null;
  const h = window.location.hash.replace(/^#/, '');
  if (h === 'checker') return 'checker';
  if (h === 'pos') return 'pos';
  if (h === 'accountant') return 'accountant';
  if (h === '' || h === '/') return 'landing';
  return null;
}

export function App() {
  return (
    <BrowserRouter>
      <FirmContextProvider>
        <DirectionProvider>
          <AppRoutes />
        </DirectionProvider>
      </FirmContextProvider>
    </BrowserRouter>
  );
}

function AppRoutes() {
  const location = useLocation();
  // The existing navigation uses `#checker`, `#pos`, `#accountant` hashes under
  // the root path. We render the legacy app when we're at `/` and listen for
  // hash changes, exactly like before; react-router handles anything else.
  const atRoot = location.pathname === '/' || location.pathname === '';

  if (atRoot) {
    return <LegacyRouter />;
  }

  return (
    <main className="min-h-screen bg-slate-50 font-sans text-slate-900">
      <div className="mx-auto max-w-4xl px-6 py-10">
        <AppHeader />
        <div className="mt-8">
          <Routes>
            <Route path="/firms/new" element={<FirmBootstrapPage />} />
            <Route path="/firms/invitations/accept" element={<AcceptInvitationPage />} />
            <Route path="/firms/:id/members" element={<FirmMembersPage />} />
            <Route path="/firms/:id/dashboard" element={<DashboardPage />} />
            <Route path="/firms/:id/imports" element={<ImportWizardPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </div>
      </div>
    </main>
  );
}

function LegacyRouter() {
  const [route, setRoute] = useState<HashRoute>(readHashRoute);

  useEffect(() => {
    const onHashChange = () => setRoute(readHashRoute());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  if (route === 'pos') {
    return <PosPage />;
  }

  return (
    <main className="min-h-screen bg-slate-50 font-sans text-slate-900">
      <div className="mx-auto max-w-3xl px-6 py-10">
        <AppHeader />
        <div className="mt-10">
          {route === 'checker' ? (
            <CheckerPage />
          ) : route === 'accountant' ? (
            <AccountantPage />
          ) : (
            <LandingPage />
          )}
        </div>
      </div>
    </main>
  );
}

function AppHeader() {
  const { t } = useTranslation();
  const { isFirmUser } = useFirmContext();
  const navigate = useNavigate();

  const goHome = (ev: React.MouseEvent) => {
    ev.preventDefault();
    navigate('/');
    // Clear any legacy hash route so the landing is shown.
    if (typeof window !== 'undefined' && window.location.hash) {
      window.location.hash = '';
    }
  };

  return (
    <header className="flex items-center justify-between gap-3">
      <a
        href="/"
        onClick={goHome}
        className="text-start text-2xl font-bold text-slate-900 no-underline rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
      >
        {t('brand')}
      </a>
      <div className="flex items-center gap-3">
        {isFirmUser && <FirmSwitcher />}
        <LanguageToggle />
      </div>
    </header>
  );
}

function LandingPage() {
  const { t } = useTranslation();
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <h1 className="text-start text-2xl font-bold text-slate-900">{t('landing.title')}</h1>
      <p className="mt-2 text-start text-base text-slate-700">{t('tagline')}</p>
      <p className="mt-2 text-start text-sm text-slate-500">{t('landing.subtitle')}</p>

      <div className="mt-6 flex items-center">
        <span
          aria-hidden="true"
          className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-indigo-100 text-indigo-700 font-semibold me-4"
        >
          F
        </span>
        <a
          href="#checker"
          className="ps-5 pe-5 py-2 rounded-md bg-indigo-600 text-white font-medium hover:bg-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        >
          {t('landing.cta')}
        </a>
      </div>
    </section>
  );
}

function NotFoundPage() {
  const { t } = useTranslation();
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <h1 className="text-start text-xl font-semibold text-slate-900">
        {t('firms.not_found.title')}
      </h1>
      <p className="mt-2 text-start text-sm text-slate-700">{t('firms.not_found.body')}</p>
      <div className="mt-4">
        <Link
          to="/"
          className="ps-4 pe-4 py-2 rounded-md bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        >
          {t('firms.not_found.home')}
        </Link>
      </div>
    </section>
  );
}

export default App;
