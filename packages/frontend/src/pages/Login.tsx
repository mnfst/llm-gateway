import { A, useLocation, useSearchParams } from '@solidjs/router';
import { Title, Meta } from '@solidjs/meta';
import { type Component, createSignal, createUniqueId, onCleanup, onMount, Show } from 'solid-js';
import SocialButtons from '../components/SocialButtons.jsx';
import { authClient } from '../services/auth-client.js';
import { appendSearch, getAuthDestination } from '../services/auth-redirects.js';
import { getLastAuthMethod, setLastAuthMethod } from '../services/last-auth-method.js';
import { checkSocialProviders } from '../services/setup-status.js';

const RESEND_COOLDOWN_SECONDS = 60;

// Dev-only seed credentials (see packages/backend/src/database/database-seeder.service.ts,
// seeded only when SEED_DATA=true / non-production). Referenced solely inside the
// `import.meta.env.DEV` branch below, so Vite strips both the button and these literals
// from production builds — they never ship. The account exists only in a dev database.
const DEV_EMAIL = 'admin@manifest.build';
const DEV_PASSWORD = 'manifest';

const Login: Component = () => {
  const [email, setEmail] = createSignal('');
  const [password, setPassword] = createSignal('');
  const [error, setError] = createSignal('');
  const [loading, setLoading] = createSignal(false);
  const [needsVerification, setNeedsVerification] = createSignal(false);
  const [resendCooldown, setResendCooldown] = createSignal(0);
  const [socialProviders, setSocialProviders] = createSignal<string[]>([]);
  const [lastAuthMethod] = createSignal(getLastAuthMethod());
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const emailId = createUniqueId();
  const passwordId = createUniqueId();
  const errorId = createUniqueId();

  onMount(async () => {
    if (searchParams.error === 'account_not_linked') {
      setNeedsVerification(true);
      setError('This email already has an account. Enter it below to get a verification link.');
    } else if (searchParams.error || searchParams.oauth === 'failed') {
      setError('Login failed. Please try again or use a different method.');
    }
    setSocialProviders(await checkSocialProviders());
  });

  let cooldownInterval: ReturnType<typeof setInterval> | undefined;

  const startCooldown = () => {
    setResendCooldown(RESEND_COOLDOWN_SECONDS);
    if (cooldownInterval) clearInterval(cooldownInterval);
    cooldownInterval = setInterval(() => {
      setResendCooldown((prev) => {
        if (prev <= 1) {
          clearInterval(cooldownInterval);
          cooldownInterval = undefined;
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  onCleanup(() => {
    if (cooldownInterval) clearInterval(cooldownInterval);
  });

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    setError('');
    setNeedsVerification(false);
    setLoading(true);

    const { error: authError } = await authClient.signIn.email({
      email: email(),
      password: password(),
    });

    setLoading(false);

    if (authError) {
      const msg = authError.message ?? '';
      if (
        msg.toLowerCase().includes('email is not verified') ||
        authError.code === 'EMAIL_NOT_VERIFIED'
      ) {
        setNeedsVerification(true);
        setError('Please verify your email before signing in.');
        return;
      }
      setError(msg || 'Invalid email or password');
      return;
    }

    setLastAuthMethod('email');
    window.location.href = getAuthDestination(searchParams, location.search);
  };

  // Dev shortcut: fill + submit the seed admin. One click, no credentials in the URL;
  // compiled out of production (see DEV_EMAIL/DEV_PASSWORD).
  const signInAsDev = async () => {
    setEmail(DEV_EMAIL);
    setPassword(DEV_PASSWORD);
    setError('');
    setLoading(true);
    const { error: authError } = await authClient.signIn.email({
      email: DEV_EMAIL,
      password: DEV_PASSWORD,
    });
    setLoading(false);
    if (authError) {
      setError(authError.message ?? 'Dev sign-in failed');
      return;
    }
    setLastAuthMethod('email');
    window.location.href = '/';
  };

  const handleResendVerification = async () => {
    if (resendCooldown() > 0) return;
    if (!email().trim()) {
      setError('Enter your email address to receive a verification link.');
      return;
    }

    const { error: resendError } = await authClient.sendVerificationEmail({
      email: email(),
      callbackURL: getAuthDestination(searchParams, location.search),
    });

    if (resendError) {
      setError(resendError.message ?? 'Failed to resend verification email');
      return;
    }

    startCooldown();
    setError('Verification email sent! Check your inbox.');
  };

  return (
    <>
      <Title>Sign In - Manifest</Title>
      <Meta name="description" content="Sign in to Manifest to monitor your AI harnesses." />
      <div class="auth-header">
        <h1 class="auth-header__title">Welcome back</h1>
        <p class="auth-header__subtitle">Take control of your AI harness costs</p>
      </div>

      <SocialButtons enabledProviders={socialProviders()} lastUsed={lastAuthMethod()} />

      <Show when={socialProviders().length > 0}>
        <div class="auth-divider">
          <span class="auth-divider__text">or</span>
        </div>
      </Show>

      <form class="auth-form" onSubmit={handleSubmit}>
        {import.meta.env.DEV && (
          <button
            type="button"
            class="auth-form__submit"
            onClick={signInAsDev}
            disabled={loading()}
            style="background:#f59e0b;color:#1f1400;font-weight:700;margin-bottom:0.75rem;"
          >
            ⚡ Sign in as dev, admin@manifest.build
          </button>
        )}
        {error() && (
          <div id={errorId} class="auth-form__error" role="alert">
            {error()}
          </div>
        )}
        <label class="auth-form__label" for={emailId}>
          Email
          <input
            ref={(el) => requestAnimationFrame(() => el.focus())}
            id={emailId}
            class="auth-form__input"
            type="email"
            autocomplete="email"
            placeholder="you@example.com"
            value={email()}
            onInput={(e) => setEmail(e.currentTarget.value)}
            required
            aria-describedby={error() ? errorId : undefined}
          />
        </label>
        <Show when={needsVerification()}>
          <button
            type="button"
            class="auth-form__link-btn"
            onClick={handleResendVerification}
            disabled={resendCooldown() > 0}
          >
            {resendCooldown() > 0 ? `Resend in ${resendCooldown()}s` : 'Send verification email'}
          </button>
        </Show>
        <label class="auth-form__label" for={passwordId}>
          Password
          <input
            id={passwordId}
            class="auth-form__input"
            type="password"
            autocomplete="current-password"
            placeholder="Enter your password"
            value={password()}
            onInput={(e) => setPassword(e.currentTarget.value)}
            required
            aria-describedby={error() ? errorId : undefined}
          />
        </label>
        <div class="auth-form__actions">
          <A href="/reset-password" class="auth-form__forgot">
            Forgot password?
          </A>
        </div>
        <button class="auth-form__submit" type="submit" disabled={loading()}>
          {loading() ? <span class="spinner" /> : 'Sign in'}
        </button>
      </form>
      <div class="auth-footer">
        <span>Don't have an account? </span>
        <A href={appendSearch('/register', location.search)} class="auth-footer__link">
          Sign up
        </A>
      </div>
    </>
  );
};

export default Login;
