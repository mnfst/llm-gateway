import { createEffect, createSignal, onCleanup, Show, type Component } from 'solid-js';

const STORAGE_OPEN = 'manifest:wingman:open';
const STORAGE_HEIGHT = 'manifest:wingman:height';
const MIN_HEIGHT_VH = 20;
const MAX_HEIGHT_VH = 90;
const DEFAULT_HEIGHT_VH = 50;

function readStoredOpen(): boolean {
  try {
    return localStorage.getItem(STORAGE_OPEN) === '1';
  } catch {
    return false;
  }
}

function readStoredHeight(): number {
  try {
    const raw = localStorage.getItem(STORAGE_HEIGHT);
    if (!raw) return DEFAULT_HEIGHT_VH;
    const n = Number(raw);
    if (!Number.isFinite(n)) return DEFAULT_HEIGHT_VH;
    return Math.min(MAX_HEIGHT_VH, Math.max(MIN_HEIGHT_VH, n));
  } catch {
    return DEFAULT_HEIGHT_VH;
  }
}

function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

const WingmanDevTools: Component = () => {
  const [open, setOpen] = createSignal(readStoredOpen());
  const [heightVh, setHeightVh] = createSignal(readStoredHeight());
  const [resizing, setResizing] = createSignal(false);

  // `__WINGMAN_URL__` is set by vite.config.ts to a loopback origin in dev: the
  // Wingman dev proxy republishes the hosted SPA there so the iframe sits in
  // the same address space as the gateway it calls. Framing the hosted HTTPS
  // origin directly makes every request a local-network request, which Chrome
  // blocks (see wingman-dev-proxy.ts). The literal is only a fallback for a
  // build that didn't define it.
  const HOSTED_WINGMAN_URL = 'https://wingman.manifest.build';
  const deriveWingmanBase = (): string => __WINGMAN_URL__ || HOSTED_WINGMAN_URL;

  const iframeSrc = () =>
    `${deriveWingmanBase()}?baseUrl=${encodeURIComponent(window.location.origin)}`;

  const setOpenPersist = (next: boolean) => {
    setOpen(next);
    writeStored(STORAGE_OPEN, next ? '1' : '0');
  };

  const setHeightPersist = (next: number) => {
    const clamped = Math.min(MAX_HEIGHT_VH, Math.max(MIN_HEIGHT_VH, next));
    setHeightVh(clamped);
    writeStored(STORAGE_HEIGHT, String(clamped));
  };

  const onResizePointerDown = (e: PointerEvent) => {
    e.preventDefault();
    setResizing(true);
    const move = (ev: PointerEvent) => {
      const fromBottom = window.innerHeight - ev.clientY;
      const vh = (fromBottom / window.innerHeight) * 100;
      setHeightPersist(vh);
    };
    const up = () => {
      setResizing(false);
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  };

  // Global Escape closes the drawer; Cmd/Ctrl+Shift+W toggles it.
  createEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open()) {
        setOpenPersist(false);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'W' || e.key === 'w')) {
        e.preventDefault();
        setOpenPersist(!open());
      }
    };
    document.addEventListener('keydown', handler);
    onCleanup(() => document.removeEventListener('keydown', handler));
  });

  return (
    <>
      <Show when={!open()}>
        <button
          type="button"
          class="wingman-fab"
          onClick={() => setOpenPersist(true)}
          title="Open Wingman, gateway tester (⌘/Ctrl + Shift + W)"
          aria-label="Open Wingman gateway tester"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z" />
            <line x1="16" y1="8" x2="2" y2="22" />
            <line x1="17.5" y1="15" x2="9" y2="15" />
          </svg>
          <span class="wingman-fab__label">Wingman</span>
        </button>
      </Show>

      <Show when={open()}>
        <aside
          class="wingman-drawer"
          classList={{ 'wingman-drawer--resizing': resizing() }}
          style={{ height: `${heightVh()}vh` }}
          aria-label="Wingman gateway tester"
        >
          <div
            class="wingman-drawer__resizer"
            onPointerDown={onResizePointerDown}
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize Wingman drawer"
            title="Drag to resize"
          />
          <header class="wingman-drawer__head">
            <div class="wingman-drawer__title">
              <strong>Wingman</strong>
            </div>
            <div class="wingman-drawer__actions">
              <a
                href={iframeSrc()}
                target="_blank"
                rel="noopener noreferrer"
                class="wingman-drawer__icon-btn"
                title="Open Wingman in a new tab"
                aria-label="Open Wingman in a new tab"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                  <polyline points="15 3 21 3 21 9" />
                  <line x1="10" y1="14" x2="21" y2="3" />
                </svg>
              </a>
              <button
                type="button"
                class="wingman-drawer__icon-btn"
                onClick={() => setOpenPersist(false)}
                title="Close (Esc)"
                aria-label="Close Wingman drawer"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          </header>
          {/* `local-network-access` is delegated as a fallback. It is not
              needed when the drawer points at the loopback proxy (same
              address space, no permission involved), but if someone points
              VITE_WINGMAN_URL back at an https origin it's the difference
              between Chrome offering the permission prompt and denying it
              outright by permissions policy, with no prompt possible. */}
          <iframe
            src={iframeSrc()}
            class="wingman-drawer__frame"
            title="Wingman gateway tester"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-clipboard-write"
            allow="clipboard-read; clipboard-write; local-network-access"
          />
        </aside>
      </Show>
    </>
  );
};

export default WingmanDevTools;
