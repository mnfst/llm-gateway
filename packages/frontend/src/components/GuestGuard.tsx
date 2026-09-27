import { useLocation, useNavigate, useSearchParams } from '@solidjs/router';
import { Show, createEffect, createSignal, onMount, type ParentComponent } from 'solid-js';
import { authClient } from '../services/auth-client.js';
import { getAuthDestination, signedOAuthDestination } from '../services/auth-redirects.js';
import { checkNeedsSetup } from '../services/setup-status.js';
import { hasPlanBeenChosen } from '../services/plan-selection.js';
import { getDiscoveryPendingNext } from '../services/discovery.js';

const GuestGuard: ParentComponent = (props) => {
  const session = authClient.useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [setupChecked, setSetupChecked] = createSignal(false);
  const [ready, setReady] = createSignal(false);

  onMount(async () => {
    const needsSetup = await checkNeedsSetup();
    if (needsSetup) {
      navigate('/setup', { replace: true });
      return;
    }
    setSetupChecked(true);
  });

  createEffect(() => {
    const s = session();
    const step = Array.isArray(searchParams.step) ? searchParams.step[0] : searchParams.step;
    if (!s.isPending && s.data) {
      const destination = getAuthDestination(searchParams, location.search);
      if (signedOAuthDestination(location.search) === destination) {
        globalThis.location.assign(destination);
        return;
      }
      // An unfinished discovery step outranks the usual destinations:
      // browser Back into the auth pages must land on the form, not fall
      // through to the dashboard.
      const pendingNext = getDiscoveryPendingNext(s.data.user?.id ?? '');
      if (pendingNext !== null) {
        navigate(`/discovery?next=${encodeURIComponent(pendingNext)}`, { replace: true });
        return;
      }
      if (step === 'plan' && !hasPlanBeenChosen(s.data.user?.id ?? '')) {
        if (setupChecked()) setReady(true);
        return;
      }
      navigate(destination, { replace: true });
    }
    if (setupChecked() && !s.isPending && !s.data) {
      setReady(true);
    }
  });

  return (
    <Show when={ready()} fallback={null}>
      {props.children}
    </Show>
  );
};

export default GuestGuard;
