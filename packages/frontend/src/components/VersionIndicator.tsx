import { createResource, createSignal, Show } from 'solid-js';
import { getVersionInfo, type VersionInfo } from '../services/api/version.js';

/**
 * localStorage key holding the `latest` version the user dismissed. The
 * notice stays hidden while the latest release is that version and comes
 * back on its own once an even newer one is published.
 */
export const UPDATE_DISMISSED_STORAGE_KEY = 'manifest.update-dismissed';

function readDismissed(): string | null {
  try {
    return localStorage.getItem(UPDATE_DISMISSED_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeDismissed(version: string): void {
  try {
    localStorage.setItem(UPDATE_DISMISSED_STORAGE_KEY, version);
  } catch {
    // Private mode or blocked storage: the in-memory signal still hides it
    // for this page load.
  }
}

/**
 * Bottom-corner `vX.Y.Z` badge for self-hosted installs. When the backend
 * reports a newer release, the badge grows a link to the changelog for that
 * release, with a dismiss button. A failed check degrades to the plain badge.
 */
const VersionIndicator = () => {
  const isSelfHosted = import.meta.env.VITE_MANIFEST_SELFHOSTED === 'true';
  const version = __MANIFEST_VERSION__;

  const [info] = createResource<VersionInfo | null, boolean>(
    () => isSelfHosted && Boolean(version),
    () => getVersionInfo().catch(() => null),
  );
  const [dismissed, setDismissed] = createSignal<string | null>(readDismissed());

  const update = (): (VersionInfo & { latest: string }) | null => {
    const v = info();
    if (!v?.update_available || !v.latest) return null;
    return dismissed() === v.latest ? null : { ...v, latest: v.latest };
  };
  const dismiss = (latest: string) => {
    setDismissed(latest);
    writeDismissed(latest);
  };

  return (
    <Show when={isSelfHosted && version}>
      <div
        class="version-indicator"
        classList={{ 'version-indicator--update': update() !== null }}
        aria-label={
          update()
            ? `Version ${version}, update to ${update()?.latest} available`
            : `Version ${version}`
        }
      >
        <span>v{version}</span>
        <Show when={update()}>
          {(u) => (
            <span class="version-indicator__update">
              <a href={u().release_url ?? undefined} target="_blank" rel="noopener noreferrer">
                v{u().latest} available
              </a>
              <button
                type="button"
                class="version-indicator__dismiss"
                aria-label="Dismiss update notice"
                onClick={() => dismiss(u().latest)}
              >
                ×
              </button>
            </span>
          )}
        </Show>
      </div>
    </Show>
  );
};

export default VersionIndicator;
