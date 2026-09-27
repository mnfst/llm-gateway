import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, screen, waitFor, configure } from '@solidjs/testing-library';
import type { ProviderParamSpec } from 'manifest-shared';

vi.mock('solid-js/web', async (importOriginal) => {
  const mod = await importOriginal<typeof import('solid-js/web')>();
  return { ...mod, Portal: (props: any) => props.children };
});

import ModelParamsAffordance from '../../src/components/ModelParamsAffordance';
import { getModelParamSpecs } from '../../src/services/api/model-params.js';

vi.mock('../../src/services/api/model-params.js', () => ({
  getModelParamSpecs: vi.fn(),
}));

const mockGetSpecs = vi.mocked(getModelParamSpecs);

const specs: ProviderParamSpec[] = [
  {
    path: 'thinking.type',
    type: 'enum',
    label: 'Thinking mode',
    description: 'Controls whether DeepSeek thinking mode is enabled.',
    default: 'enabled',
    values: ['enabled', 'disabled'],
    group: 'reasoning',
  },
];

const baseProps = {
  agentName: 'demo',
  provider: 'deepseek',
  authType: 'api_key' as const,
  model: 'deepseek-v4',
  slotLabel: 'deepseek-v4',
  scope: 'tier:default',
  getParams: vi.fn(() => null),
  setParams: vi.fn().mockResolvedValue(undefined),
};

const findButton = (container: HTMLElement) =>
  container.querySelector('button[aria-label^="Configure model parameters"]');

describe('ModelParamsAffordance', () => {
  beforeEach(() => {
    mockGetSpecs.mockReset();
    mockGetSpecs.mockResolvedValue(specs);
    // These assertions wait on a lazily-loaded resource (getModelParamSpecs) and a
    // reactive `Show` gate; the default 1s waitFor budget can be exceeded under CI
    // CPU contention, so give it headroom to avoid load-based flakes.
    configure({ asyncUtilTimeout: 5000 });
  });

  afterEach(() => {
    configure({ asyncUtilTimeout: 1000 });
  });

  it('renders the button for non-local routes', () => {
    const { container } = render(() => <ModelParamsAffordance {...baseProps} />);
    expect(findButton(container)).not.toBeNull();
  });

  it('opens a model with no parameters and links to a prefilled request', async () => {
    mockGetSpecs.mockResolvedValue([]);
    const { container } = render(() => (
      <ModelParamsAffordance {...baseProps} provider="openai" model="gpt-4o" slotLabel="gpt-4o" />
    ));
    const btn = container.querySelector(
      'button[aria-label="Configure model parameters for gpt-4o"]',
    ) as HTMLButtonElement;
    expect(btn).not.toBeNull();

    fireEvent.click(btn);

    // Wait for specs to finish loading — the link only appears after loading is
    // done. The desc text shows immediately but the empty-state link is gated
    // behind Show when={!loading}.
    const link = (await waitFor(() =>
      screen.getByRole('link', { name: 'Request model parameters for gpt-4o' }),
    )) as HTMLAnchorElement;
    expect(screen.getByText('No parameter controls are published for gpt-4o yet.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(link.textContent).toBe('Request parameters for this model');
    const url = new URL(link.href);
    expect(`${url.origin}${url.pathname}`).toBe(
      'https://github.com/mnfst/modelparams.dev/issues/new',
    );
    expect(url.searchParams.get('template')).toBeNull();
    expect(url.searchParams.get('title')).toBe('Parameters: openai/gpt-4o');
    expect(url.searchParams.get('labels')).toBe('parameters');
    expect(url.searchParams.get('body')).toBe(
      'Model: `openai/gpt-4o`\nAuth type: API key\n\nPlease add the configurable request parameters for this model.',
    );
  });

  it('prefills subscription auth type in the request body', async () => {
    mockGetSpecs.mockResolvedValue([]);
    const { container } = render(() => (
      <ModelParamsAffordance
        {...baseProps}
        authType="subscription"
        provider="anthropic"
        model="claude-sonnet-4-6"
        slotLabel="Claude Sonnet 4.6"
      />
    ));

    fireEvent.click(
      container.querySelector(
        'button[aria-label="Configure model parameters for Claude Sonnet 4.6"]',
      ) as HTMLButtonElement,
    );

    const link = (await waitFor(() =>
      screen.getByRole('link', {
        name: 'Request model parameters for Claude Sonnet 4.6',
      }),
    )) as HTMLAnchorElement;
    const url = new URL(link.href);
    expect(url.searchParams.get('title')).toBe('Parameters: anthropic/claude-sonnet-4-6');
    expect(url.searchParams.get('body')).toContain('Auth type: Subscription');
  });

  it('does not render the button when authType is missing', () => {
    // Explicit props (no spread): Solid's mergeProps skips `undefined`
    // overrides, so spreading baseProps would keep the truthy value.
    const { container } = render(() => (
      <ModelParamsAffordance
        agentName="demo"
        provider="deepseek"
        authType={undefined}
        model="deepseek-v4"
        slotLabel="deepseek-v4"
        scope="tier:default"
        getParams={() => null}
        setParams={vi.fn()}
      />
    ));
    expect(findButton(container)).toBeNull();
  });

  it('does not render the button when provider is undefined', () => {
    const { container } = render(() => (
      <ModelParamsAffordance
        agentName="demo"
        provider={undefined}
        authType="api_key"
        model="deepseek-v4"
        slotLabel="deepseek-v4"
        scope="tier:default"
        getParams={() => null}
        setParams={vi.fn()}
      />
    ));
    expect(findButton(container)).toBeNull();
  });

  it('does not render the button for local routes', () => {
    const { container } = render(() => <ModelParamsAffordance {...baseProps} authType="local" />);
    expect(container.querySelector('button[aria-label^="Configure model parameters"]')).toBeNull();
  });

  it('flips the configured class when getParams returns a non-null value', () => {
    const { container } = render(() => (
      <ModelParamsAffordance
        {...baseProps}
        getParams={() => ({ thinking: { type: 'disabled' } })}
      />
    ));
    const btn = findButton(container) as HTMLButtonElement;
    expect(btn.classList.contains('routing-card__chip-action--configured')).toBe(true);
  });

  it('fetches specs on open and saves through the scoped params callback', async () => {
    const setParams = vi.fn().mockResolvedValue(undefined);
    const { container, getByRole } = render(() => (
      <ModelParamsAffordance {...baseProps} setParams={setParams} />
    ));
    fireEvent.click(findButton(container) as HTMLButtonElement);

    fireEvent.click(await waitFor(() => getByRole('button', { name: /Thinking mode/ })));
    expect(getByRole('link', { name: 'Request parameters for deepseek-v4' })).toBeTruthy();
    fireEvent.click(getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(setParams).toHaveBeenCalledWith('tier:default', 'deepseek', 'api_key', 'deepseek-v4', {
        thinking: { type: 'disabled' },
      });
    });
    expect(mockGetSpecs).toHaveBeenCalledWith('demo', 'deepseek', 'api_key', 'deepseek-v4');
  });

  it('saves null when the chosen value collapses back to the spec default', async () => {
    const setParams = vi.fn().mockResolvedValue(undefined);
    const { container, getByRole } = render(() => (
      <ModelParamsAffordance
        {...baseProps}
        getParams={() => ({ thinking: { type: 'disabled' } })}
        setParams={setParams}
      />
    ));
    fireEvent.click(findButton(container) as HTMLButtonElement);

    fireEvent.click(await waitFor(() => getByRole('button', { name: /Thinking mode/ })));
    fireEvent.click(getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(setParams).toHaveBeenCalledWith(
        'tier:default',
        'deepseek',
        'api_key',
        'deepseek-v4',
        null,
      );
    });
  });

  it('shows an empty state when the model has no configurable params', async () => {
    mockGetSpecs.mockResolvedValue([]);
    const { container, findByText, queryByRole } = render(() => (
      <ModelParamsAffordance {...baseProps} />
    ));
    fireEvent.click(findButton(container) as HTMLButtonElement);

    expect(await findByText('No parameter controls are published for deepseek-v4 yet.')).toBeTruthy();
    expect(queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('swallows a fetch error and shows the empty state', async () => {
    mockGetSpecs.mockRejectedValue(new Error('boom'));
    const { container, findByText } = render(() => <ModelParamsAffordance {...baseProps} />);
    fireEvent.click(findButton(container) as HTMLButtonElement);

    expect(await findByText('No parameter controls are published for deepseek-v4 yet.')).toBeTruthy();
  });

  it('button is disabled when the parent says so', () => {
    const { container } = render(() => <ModelParamsAffordance {...baseProps} disabled />);
    const btn = findButton(container) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });
});
