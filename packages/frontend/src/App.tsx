import { useLocation } from '@solidjs/router';
import {
  createEffect,
  createSignal,
  lazy,
  onCleanup,
  onMount,
  Show,
  Suspense,
  type ParentComponent,
} from 'solid-js';
import Header from './components/Header.jsx';
import Sidebar from './components/Sidebar.jsx';
import AuthGuard from './components/AuthGuard.jsx';
import VersionIndicator from './components/VersionIndicator.jsx';
import UsageLimitBanner from './components/UsageLimitBanner.jsx';
import AutofixBanner from './components/AutofixBanner.jsx';
import { connectSse } from './services/sse.js';
import { RightSidebarProvider, useRightSidebar } from './services/right-sidebar.jsx';

// Dev-only gateway tester. Gating the dynamic import behind the compile-time
// `__DEV_MODE__` flag lets rollup drop both the component and its transitive
// deps from production/self-hosted bundles — a static import can leak in when
// transitive deps have side effects, since `define` runs after graph build.
const WingmanDevTools = __DEV_MODE__
  ? lazy(() => import('./components/WingmanDevTools.jsx'))
  : null;

const SseConnector: ParentComponent = (props) => {
  onMount(() => {
    const cleanup = connectSse();
    onCleanup(cleanup);
  });
  return <>{props.children}</>;
};

const AppInner: ParentComponent = (props) => {
  const location = useLocation();
  const [mobileNavOpen, setMobileNavOpen] = createSignal(false);
  // The sidebar is global and rendered identically on every authenticated
  // route. Guest/setup routes never reach this component, so we show the
  // sidebar everywhere except the root redirect ("/") which navigates away
  // immediately and needs no nav chrome.
  const showSidebar = () => location.pathname !== '/';
  const { content: rightSidebar } = useRightSidebar();

  createEffect<string | undefined>((previousPath) => {
    const currentPath = location.pathname;
    if (currentPath === previousPath) return currentPath;
    setMobileNavOpen(false);
    return currentPath;
  });

  return (
    <div class="app-shell">
      <a href="#main-content" class="skip-link">
        Skip to main content
      </a>
      <Header
        showMobileNavToggle={showSidebar()}
        mobileNavOpen={mobileNavOpen()}
        onMobileNavToggle={() => setMobileNavOpen((open) => !open)}
      />
      <Show when={showSidebar()}>
        <Show when={mobileNavOpen()}>
          <button
            type="button"
            class="mobile-nav-backdrop"
            aria-label="Close navigation menu"
            onClick={() => setMobileNavOpen(false)}
          />
        </Show>
      </Show>
      <div class="app-body" classList={{ 'app-body--with-sidebar': showSidebar() }}>
        <Show when={showSidebar()}>
          <Sidebar mobileOpen={mobileNavOpen()} onNavigate={() => setMobileNavOpen(false)} />
        </Show>
        <main
          id="main-content"
          class="main-content"
          classList={{ 'main-content--full': !showSidebar() }}
          aria-label="Dashboard content"
        >
          <UsageLimitBanner />
          <AutofixBanner />
          {props.children}
        </main>
        {rightSidebar()}
      </div>
      <VersionIndicator />
      {__DEV_MODE__ && WingmanDevTools && (
        <Suspense fallback={null}>
          <WingmanDevTools />
        </Suspense>
      )}
    </div>
  );
};

const App: ParentComponent = (props) => {
  return (
    <AuthGuard>
      <SseConnector>
        <RightSidebarProvider>
          <AppInner>{props.children}</AppInner>
        </RightSidebarProvider>
      </SseConnector>
    </AuthGuard>
  );
};

export default App;
