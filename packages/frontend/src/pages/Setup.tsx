import { useNavigate } from '@solidjs/router';
import { Title, Meta } from '@solidjs/meta';
import { type Component, createSignal, onMount, Show } from 'solid-js';
import { authClient } from '../services/auth-client.js';
import { buildLoginRedirect } from '../services/auth-redirects.js';
import { checkIsSelfHosted, checkNeedsSetup, createFirstAdmin } from '../services/setup-status.js';
import { markDiscoveryPending } from '../services/discovery.js';

const Setup: Component = () => {
  const navigate = useNavigate();
  const [email, setEmail] = createSignal('');
  const [name, setName] = createSignal('');
  const [password, setPassword] = createSignal('');
  const [confirmPassword, setConfirmPassword] = createSignal('');
  const [error, setError] = createSignal('');
  const [loading, setLoading] = createSignal(false);
  const [checking, setChecking] = createSignal(true);

  onMount(async () => {
    const needsSetup = await checkNeedsSetup();
    if (!needsSetup) {
      navigate('/login', { replace: true });
      return;
    }
    setChecking(false);
  });

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    setError('');

    if (password() !== confirmPassword()) {
      setError('Passwords do not match');
      return;
    }
    if (password().length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }

    setLoading(true);
    try {
      await createFirstAdmin({ email: email(), name: name(), password: password() });

      // Auto sign-in with the credentials just created.
      const { data: signInData, error: authError } = await authClient.signIn.email({
        email: email(),
        password: password(),
      });
      if (authError) {
        // Creation succeeded but sign-in failed. Preserve the new-account
        // destination so a later manual login still reaches discovery.
        navigate(buildLoginRedirect('/discovery', '?next=%2F&signup=1'), { replace: true });
        return;
      }
      // New self-hosted admins get the one-time discovery step first; the
      // pending marker lets the guards route them back until it is done.
      if (await checkIsSelfHosted()) {
        markDiscoveryPending(signInData?.user?.id ?? '', '/');
        window.location.href = '/discovery';
      } else {
        window.location.href = '/';
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Setup failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Title>Set up Manifest</Title>
      <Meta name="description" content="Create the admin account for your Manifest instance." />
      <Show when={!checking()} fallback={<div class="auth-header__subtitle">Loading...</div>}>
        <div class="auth-header">
          <h1 class="auth-header__title">Welcome to Manifest</h1>
          <p class="auth-header__subtitle">Create the admin account for your instance</p>
        </div>
        <form class="auth-form" onSubmit={handleSubmit}>
          {error() && (
            <div class="auth-form__error" role="alert">
              {error()}
            </div>
          )}
          <label class="auth-form__label">
            Name
            <input
              class="auth-form__input"
              type="text"
              placeholder="Your name"
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
              required
              minLength={2}
              maxLength={100}
            />
          </label>
          <label class="auth-form__label">
            Email
            <input
              class="auth-form__input"
              type="email"
              placeholder="you@example.com"
              value={email()}
              onInput={(e) => setEmail(e.currentTarget.value)}
              required
            />
          </label>
          <label class="auth-form__label">
            Password
            <input
              class="auth-form__input"
              type="password"
              placeholder="At least 8 characters"
              value={password()}
              onInput={(e) => setPassword(e.currentTarget.value)}
              required
              minLength={8}
              maxLength={128}
            />
          </label>
          <label class="auth-form__label">
            Confirm password
            <input
              class="auth-form__input"
              type="password"
              placeholder="Re-enter password"
              value={confirmPassword()}
              onInput={(e) => setConfirmPassword(e.currentTarget.value)}
              required
              minLength={8}
              maxLength={128}
            />
          </label>
          <button class="auth-form__submit" type="submit" disabled={loading()}>
            {loading() ? <span class="spinner" /> : 'Create admin account'}
          </button>
        </form>
      </Show>
    </>
  );
};

export default Setup;
