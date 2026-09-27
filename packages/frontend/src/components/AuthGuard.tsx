import { useLocation, useNavigate } from '@solidjs/router';
import { Show, createEffect, createSignal, type ParentComponent } from 'solid-js';
import { authClient } from '../services/auth-client.js';
import { buildLoginRedirect } from '../services/auth-redirects.js';
import { hasPlanBeenChosen, markPlanChosen } from '../services/plan-selection.js';
import { hasOnboardingBeenDone } from '../services/onboarding.js';
import { getDiscoveryPendingNext } from '../services/discovery.js';
import { loadPlan } from '../services/plan-store.js';

const AuthGuard: ParentComponent = (props) => {
  const session = authClient.useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [planChecked, setPlanChecked] = createSignal(false);

  // Start the plan lookup now, in parallel with the session probe: it only
  // needs the cookie jar. The effect below awaits the same in-flight promise,
  // so the two serial round trips before first paint become one. Signed-out
  // visitors get a 401 that loadPlan neither caches nor surfaces.
  void loadPlan();

  createEffect(() => {
    const s = session();
    if (s.isPending) return;
    if (!s.data) {
      navigate(buildLoginRedirect(location.pathname, location.search), { replace: true });
      return;
    }
    // The CLI consent page and the MCP OAuth consent page are not part of
    // onboarding. Gate them on an authenticated session only, so a user who is
    // mid-discovery/plan selection can still authorize a client (otherwise the
    // login flow never gets its code).
    if (location.pathname === '/cli/auth' || location.pathname === '/consent') {
      setPlanChecked(true);
      return;
    }
    const userId = s.data.user?.id;
    // A freshly signed-up user with the discovery step still pending is sent
    // back to it from anywhere in the app except the form itself.
    const pendingNext = getDiscoveryPendingNext(userId ?? '');
    if (pendingNext !== null && location.pathname !== '/discovery') {
      navigate(`/discovery?next=${encodeURIComponent(pendingNext)}`, { replace: true });
      return;
    }
    if (planChecked()) return;
    // Resolve the plan store before rendering any page — downstream consumers
    // (range locks) read it synchronously. loadPlan never rejects (fail-open)
    // and costs one indexed query.
    loadPlan().then((status) => {
      // /register?step=plan is the plan selection destination — never intercept it.
      if (location.pathname === '/register') {
        setPlanChecked(true);
        return;
      }
      if (userId && hasPlanBeenChosen(userId)) {
        setPlanChecked(true);
        return;
      }
      // Don't gate on plan selection before the user has completed onboarding.
      if (userId && !hasOnboardingBeenDone(userId)) {
        setPlanChecked(true);
        return;
      }
      if (status.enabled && status.plan !== 'pro') {
        navigate('/register?step=plan', { replace: true });
        return;
      }
      if (userId) markPlanChosen(userId);
      setPlanChecked(true);
    });
  });

  return (
    <Show
      when={!session().isPending && session().data && planChecked()}
      fallback={
        <div class="auth-layout">
          <div class="auth-card" style="text-align: center;">
            <div class="auth-logo">
              <img
                src="/logotype-white.svg"
                alt="Manifest LLM Gateway"
                class="auth-logo__img auth-logo__img--light"
              />
              <img src="/logotype-dark.svg" alt="" class="auth-logo__img auth-logo__img--dark" />
            </div>
            <p style="color: hsl(var(--muted-foreground)); font-size: var(--font-size-sm);">
              Loading...
            </p>
          </div>
        </div>
      }
    >
      {props.children}
    </Show>
  );
};

export default AuthGuard;
