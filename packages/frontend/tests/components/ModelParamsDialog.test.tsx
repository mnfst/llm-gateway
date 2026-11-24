import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, screen, waitFor } from '@solidjs/testing-library';
import type { ProviderParamSpec, RequestParamDefaults } from 'manifest-shared';

vi.mock('solid-js/web', async (importOriginal) => {
  const mod = await importOriginal<typeof import('solid-js/web')>();
  return { ...mod, Portal: (props: any) => props.children };
});

import ModelParamsDialog from '../../src/components/ModelParamsDialog';

const q = (sel: string) => document.querySelector(sel);

const deepseekSpecs: readonly ProviderParamSpec[] = [
  {
    provider: 'deepseek',
    authType: 'api_key',
    model: 'deepseek-v4',
    path: 'thinking.type',
    type: 'enum',
    label: 'Thinking mode',
    description: 'Controls whether DeepSeek thinking mode is enabled.',
    default: 'enabled',
    values: ['enabled', 'disabled'],
    group: 'reasoning',
  },
];

const anthropicSpecs: readonly ProviderParamSpec[] = [
  {
    provider: 'anthropic',
    authType: 'api_key',
    model: 'claude-sonnet-4-6',
    path: 'thinking.type',
    type: 'enum',
    label: 'Thinking mode',
    description: 'Controls Anthropic thinking mode.',
    default: 'disabled',
    values: ['disabled', 'adaptive', 'enabled'],
    group: 'reasoning',
  },
  {
    provider: 'anthropic',
    authType: 'api_key',
    model: 'claude-sonnet-4-6',
    path: 'thinking.budget_tokens',
    type: 'integer',
    label: 'Thinking budget',
    description: 'Maximum Anthropic extended thinking token budget.',
    default: 4096,
    range: { min: 1024, max: 32768, step: 1024 },
    group: 'reasoning',
    applicability: { only: { 'thinking.type': 'enabled' } },
  },
  {
    provider: 'anthropic',
    authType: 'api_key',
    model: 'claude-sonnet-4-6',
    path: 'temperature',
    type: 'number',
    label: 'Temperature',
    description: 'Controls sampling randomness.',
    default: 1,
    range: { min: 0, max: 1, step: 0.1 },
    group: 'sampling',
    applicability: { except: { 'thinking.type': ['enabled', 'adaptive'] } },
  },
  {
    provider: 'anthropic',
    authType: 'api_key',
    model: 'claude-sonnet-4-6',
    path: 'top_p',
    type: 'number',
    label: 'Top P',
    description: 'Controls nucleus sampling.',
    default: 1,
    range: { min: 0, max: 1, step: 0.01 },
    group: 'sampling',
    applicability: {
      except: [{ 'thinking.type': ['enabled', 'adaptive'] }, { temperature: { not: 1 } }],
    },
  },
  {
    provider: 'anthropic',
    authType: 'api_key',
    model: 'claude-sonnet-4-6',
    path: 'max_tokens',
    type: 'integer',
    label: 'Max tokens',
    description: 'Maximum number of output tokens.',
    default: 4096,
    range: { min: 1 },
    group: 'generation_length',
  },
];

const anthropicAdaptiveSpecs: readonly ProviderParamSpec[] = [
  {
    provider: 'anthropic',
    authType: 'subscription',
    model: 'claude-fable-5',
    path: 'thinking.type',
    type: 'enum',
    label: 'Thinking mode',
    description:
      'Only adaptive thinking is supported; omit the parameter entirely to run without thinking.',
    values: ['adaptive'],
    group: 'reasoning',
  },
  {
    provider: 'anthropic',
    authType: 'subscription',
    model: 'claude-fable-5',
    path: 'thinking.display',
    type: 'enum',
    label: 'Thinking display',
    description: 'Controls whether Anthropic returns summarized or omitted thinking content.',
    default: 'omitted',
    values: ['summarized', 'omitted'],
    group: 'reasoning',
    applicability: { only: { 'thinking.type': ['adaptive'] } },
  },
];

const booleanSpecs: readonly ProviderParamSpec[] = [
  {
    provider: 'test',
    authType: 'api_key',
    model: 'test-model',
    path: 'logprobs',
    type: 'boolean',
    label: 'Token log probabilities',
    description: 'Controls whether token log probabilities are requested.',
    default: true,
    group: 'observability',
  },
];

describe('ModelParamsDialog', () => {
  const baseProps = {
    open: true,
    slotLabel: 'deepseek-v4',
    current: null as RequestParamDefaults | null,
    specs: deepseekSpecs,
    onClose: vi.fn(),
    onSave: vi.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => vi.clearAllMocks());

  it('renders nothing when closed', () => {
    render(() => <ModelParamsDialog {...baseProps} open={false} />);
    expect(q('.modal-overlay')).toBeNull();
  });

  it('shows a compact request action when no parameter specs are published', () => {
    render(() => (
      <ModelParamsDialog
        {...baseProps}
        specs={[]}
        requestParamsUrl="https://github.com/mnfst/modelparams.dev/issues/new?template=parameter-request.yml&provider=openai&model=gpt-4o"
        slotLabel="gpt-4o"
      />
    ));

    expect(screen.getByText('No parameter controls are published for gpt-4o yet.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Request model parameters for gpt-4o' });
    expect(link.textContent).toBe('Request parameters for this model');
    expect(link).toHaveProperty(
      'href',
      'https://github.com/mnfst/modelparams.dev/issues/new?template=parameter-request.yml&provider=openai&model=gpt-4o',
    );
  });

  it('shows the compact request link alongside published parameter controls', () => {
    render(() => (
      <ModelParamsDialog
        {...baseProps}
        requestParamsUrl="https://github.com/mnfst/modelparams.dev/issues/new?template=parameter-request.yml&provider=deepseek&model=deepseek-v4"
      />
    ));

    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Request parameters for deepseek-v4' });
    expect(link.textContent).toBe('Request');
    expect(link).toHaveProperty(
      'href',
      'https://github.com/mnfst/modelparams.dev/issues/new?template=parameter-request.yml&provider=deepseek&model=deepseek-v4',
    );
  });

  it('starts on the spec default when no override is configured', () => {
    render(() => <ModelParamsDialog {...baseProps} />);
    const toggle = q('.model-params__toggle') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(q('.provider-toggle__switch--on')).not.toBeNull();
  });

  it('explains that set values override the client and unset ones pass through', () => {
    render(() => <ModelParamsDialog {...baseProps} slotLabel="GPT-5 Nano" />);
    expect(
      screen.getByText(
        "Values you set override the client's request for GPT-5 Nano; unset ones keep the client's value. Requests that name a model instead of auto skip them.",
      ),
    ).toBeTruthy();
  });

  it('shows loading description while specs are being fetched', () => {
    render(() => <ModelParamsDialog {...baseProps} specs={[]} loading={true} slotLabel="gpt-4o" />);
    expect(screen.getByText('Loading parameters for gpt-4o…')).toBeTruthy();
  });

  it('shows fallback text when no specs and no requestParamsUrl', () => {
    render(() => (
      <ModelParamsDialog
        {...baseProps}
        specs={[]}
        requestParamsUrl={undefined}
        slotLabel="gpt-4o"
      />
    ));
    expect(screen.getByText('This model has no configurable parameters.')).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('reflects the configured override when present', () => {
    render(() => <ModelParamsDialog {...baseProps} current={{ thinking: { type: 'disabled' } }} />);
    const toggle = q('.model-params__toggle') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(q('.provider-toggle__switch--on')).toBeNull();
  });

  it('shows the human label and raw provider param path', () => {
    render(() => (
      <ModelParamsDialog {...baseProps} specs={anthropicSpecs} slotLabel="claude-sonnet-4-6" />
    ));
    expect(screen.getAllByText('Max tokens').length).toBeGreaterThan(0);
    expect(screen.getByText('max_tokens')).toBeTruthy();
  });

  it('renders descriptions from the published parameter specs', () => {
    render(() => (
      <ModelParamsDialog {...baseProps} specs={anthropicSpecs} slotLabel="claude-sonnet-4-6" />
    ));

    expect(screen.getByText('Controls sampling randomness.')).toBeTruthy();
    expect(
      screen.queryByText(
        'Low values give focused, deterministic answers. High values give more creative, varied responses.',
      ),
    ).toBeNull();
  });

  it('renders derived select, slider, and number controls from specs', () => {
    render(() => (
      <ModelParamsDialog {...baseProps} specs={anthropicSpecs} slotLabel="claude-sonnet-4-6" />
    ));
    expect(screen.getByLabelText('Thinking mode')).toBeTruthy();
    expect(screen.getByRole('slider', { name: 'Temperature' })).toBeTruthy();
    expect(screen.getByLabelText('Max tokens')).toBeTruthy();
  });

  it('lets adaptive-only enum params return to unset', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(() => (
      <ModelParamsDialog
        {...baseProps}
        specs={anthropicAdaptiveSpecs}
        slotLabel="claude-fable-5"
        current={{ thinking: { type: 'adaptive', display: 'summarized' } }}
        onSave={onSave}
      />
    ));

    fireEvent.click(screen.getByLabelText('Thinking mode'));
    fireEvent.click(screen.getByRole('option', { name: 'None' }));
    expect((screen.getByLabelText('Thinking display') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(null));
  });

  it('saves adaptive-only enum params after selecting adaptive from unset', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(() => (
      <ModelParamsDialog
        {...baseProps}
        specs={anthropicAdaptiveSpecs}
        slotLabel="claude-fable-5"
        onSave={onSave}
      />
    ));

    fireEvent.click(screen.getByLabelText('Thinking mode'));
    expect(screen.getByRole('option', { name: 'None' })).toBeTruthy();
    fireEvent.click(screen.getByRole('option', { name: 'adaptive' }));
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        thinking: { type: 'adaptive', display: 'omitted' },
      }),
    );
  });

  it('updates slider controls from keyboard input', () => {
    render(() => (
      <ModelParamsDialog {...baseProps} specs={anthropicSpecs} slotLabel="claude-sonnet-4-6" />
    ));

    const slider = screen.getByRole('slider', { name: 'Temperature' }) as HTMLInputElement;

    fireEvent.keyDown(slider, { key: 'ArrowDown' });
    expect(slider.value).toBe('0.9');

    fireEvent.keyDown(slider, { key: 'ArrowUp' });
    expect(slider.value).toBe('1');

    fireEvent.keyDown(slider, { key: 'Home' });
    expect(slider.value).toBe('0');

    fireEvent.keyDown(slider, { key: 'End' });
    expect(slider.value).toBe('1');
  });

  it('updates slider value from native input event', () => {
    render(() => (
      <ModelParamsDialog {...baseProps} specs={anthropicSpecs} slotLabel="claude-sonnet-4-6" />
    ));

    const slider = screen.getByRole('slider', { name: 'Temperature' }) as HTMLInputElement;
    fireEvent.input(slider, { target: { value: '0.5' } });
    expect(slider.value).toBe('0.5');
  });

  it('updates slider value when typing in the companion number input', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(() => (
      <ModelParamsDialog
        {...baseProps}
        specs={anthropicSpecs}
        slotLabel="claude-sonnet-4-6"
        onSave={onSave}
      />
    ));

    const numberInput = screen.getByLabelText('Temperature value') as HTMLInputElement;
    fireEvent.input(numberInput, { target: { value: '0,3' } });
    fireEvent.input(numberInput, { target: { value: '' } });
    fireEvent.input(numberInput, { target: { value: '.' } });
    fireEvent.input(numberInput, { target: { value: 'abc' } });
    fireEvent.input(numberInput, { target: { value: '0.6' } });
    fireEvent.blur(numberInput);
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ temperature: 0.6 }));
  });

  it('snaps companion number input values to the slider step before saving', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(() => (
      <ModelParamsDialog
        {...baseProps}
        specs={anthropicSpecs}
        slotLabel="claude-sonnet-4-6"
        onSave={onSave}
      />
    ));

    const numberInput = screen.getByLabelText('Temperature value') as HTMLInputElement;
    fireEvent.input(numberInput, { target: { value: '0.36' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ temperature: 0.4 }));
  });

  it('keeps integer slider values truncated when the number input is edited', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const integerSliderSpec: readonly ProviderParamSpec[] = [
      {
        provider: 'anthropic',
        authType: 'api_key',
        model: 'claude-sonnet-4-6',
        path: 'thinking.budget_tokens',
        type: 'integer',
        label: 'Thinking budget',
        description: 'Budget.',
        default: 4096,
        range: { min: 1024, max: 32768, step: 1024 },
        group: 'reasoning',
      },
    ];
    render(() => (
      <ModelParamsDialog
        {...baseProps}
        specs={integerSliderSpec}
        slotLabel="claude-sonnet-4-6"
        onSave={onSave}
      />
    ));

    const numberInput = screen.getByLabelText('Thinking budget value') as HTMLInputElement;
    fireEvent.input(numberInput, { target: { value: '8192.9' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ thinking: { budget_tokens: 8192 } }));
  });

  it('renders a tooltip explaining how to enable a blocked param (only-rule case)', () => {
    render(() => (
      <ModelParamsDialog
        {...baseProps}
        specs={anthropicSpecs}
        slotLabel="claude-sonnet-4-6"
        current={{ thinking: { type: 'disabled' } }}
      />
    ));

    const helps = document.querySelectorAll('.model-params__help');
    const messages = Array.from(helps).map((el) => el.getAttribute('aria-label'));
    expect(messages.some((m) => m && m.includes('To configure this parameter'))).toBe(true);
    expect(messages.some((m) => m && m.includes('Thinking mode'))).toBe(true);
  });

  it('formats lists of three or more required values in the help tooltip', () => {
    const specs: readonly ProviderParamSpec[] = [
      {
        provider: 'test',
        authType: 'api_key',
        model: 'test',
        path: 'mode',
        type: 'enum',
        label: 'Mode',
        description: 'Mode.',
        default: 'off',
        values: ['off', 'low', 'medium', 'high'],
        group: 'reasoning',
      },
      {
        provider: 'test',
        authType: 'api_key',
        model: 'test',
        path: 'effort',
        type: 'integer',
        label: 'Effort',
        description: 'Effort.',
        default: 1,
        range: { min: 0, max: 10, step: 1 },
        group: 'reasoning',
        applicability: { only: { mode: ['low', 'medium', 'high'] } },
      },
    ];
    render(() => <ModelParamsDialog {...baseProps} specs={specs} slotLabel="test" />);

    const messages = Array.from(document.querySelectorAll('.model-params__help')).map((el) =>
      el.getAttribute('aria-label'),
    );
    expect(messages.some((m) => m && m.includes('"low", "medium", or "high"'))).toBe(true);
  });

  it('describes blockers for primitive except rules and custom not rules', () => {
    const blockedSpecs: readonly ProviderParamSpec[] = [
      {
        provider: 'test',
        authType: 'api_key',
        model: 'test',
        path: 'mode',
        type: 'enum',
        label: 'Mode',
        description: 'Mode.',
        default: 'fast',
        values: ['fast', 'slow'],
        group: 'reasoning',
      },
      {
        provider: 'test',
        authType: 'api_key',
        model: 'test',
        path: 'noise',
        type: 'number',
        label: 'Noise',
        description: 'Noise.',
        default: 0.5,
        range: { min: 0, max: 1, step: 0.1 },
        group: 'sampling',
        applicability: { except: { mode: 'slow' } },
      },
      {
        provider: 'test',
        authType: 'api_key',
        model: 'test',
        path: 'jitter',
        type: 'number',
        label: 'Jitter',
        description: 'Jitter.',
        default: 0.5,
        range: { min: 0, max: 1, step: 0.1 },
        group: 'sampling',
        applicability: { except: { mode: { not: 'fast' } } },
      },
    ];
    render(() => (
      <ModelParamsDialog
        {...baseProps}
        specs={blockedSpecs}
        slotLabel="test"
        current={{ mode: 'slow' }}
      />
    ));

    const messages = Array.from(document.querySelectorAll('.model-params__help')).map((el) =>
      el.getAttribute('aria-label'),
    );
    expect(messages.some((m) => m && m.includes('Mode is "slow"'))).toBe(true);
    expect(messages.some((m) => m && m.includes('Mode is set to a custom value'))).toBe(true);
  });

  it('shows the slider min and max bounds', () => {
    render(() => (
      <ModelParamsDialog {...baseProps} specs={anthropicSpecs} slotLabel="claude-sonnet-4-6" />
    ));

    const slider = screen.getByRole('slider', { name: 'Temperature' });
    const field = slider.closest('.model-params__slider-field') as HTMLElement;
    const bounds = field.querySelectorAll('.model-params__slider-bound');
    expect(bounds[0]?.textContent).toBe('0');
    expect(bounds[1]?.textContent).toBe('1');
  });

  it('stores integer number controls as parsed numeric values', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(() => (
      <ModelParamsDialog
        {...baseProps}
        specs={anthropicSpecs}
        slotLabel="claude-sonnet-4-6"
        onSave={onSave}
      />
    ));

    fireEvent.input(screen.getByLabelText('Max tokens'), { target: { value: '2048.9' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ max_tokens: 2048 }));
  });

  it('keeps a stored value even when the user picks the provider default', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(() => (
      <ModelParamsDialog
        {...baseProps}
        onSave={onSave}
        current={{ thinking: { type: 'disabled' } }}
      />
    ));

    fireEvent.click(q('.model-params__toggle') as HTMLButtonElement);
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ thinking: { type: 'enabled' } }));
  });

  it('saves an explicit override when at least one value differs from the spec default', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(() => <ModelParamsDialog {...baseProps} onSave={onSave} onClose={onClose} />);

    fireEvent.click(q('.model-params__toggle') as HTMLButtonElement);
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ thinking: { type: 'disabled' } }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('keeps boolean toggle values as booleans', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(() => (
      <ModelParamsDialog
        {...baseProps}
        specs={booleanSpecs}
        slotLabel="test-model"
        onSave={onSave}
      />
    ));

    fireEvent.click(q('.model-params__toggle') as HTMLButtonElement);
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ logprobs: false }));
  });

  it('includes applicable nested sibling defaults when saving a nested override', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(() => (
      <ModelParamsDialog
        {...baseProps}
        specs={anthropicSpecs}
        slotLabel="claude-sonnet-4-6"
        onSave={onSave}
      />
    ));

    fireEvent.click(screen.getByLabelText('Thinking mode'));
    fireEvent.click(screen.getByRole('option', { name: 'enabled' }));
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        thinking: { type: 'enabled', budget_tokens: 4096 },
      }),
    );
  });

  it('disables controls when model-param availability rules make them unavailable', () => {
    render(() => (
      <ModelParamsDialog
        {...baseProps}
        specs={anthropicSpecs}
        slotLabel="claude-sonnet-4-6"
        current={{ thinking: { type: 'adaptive' } }}
      />
    ));
    expect(screen.getByRole('slider', { name: 'Temperature' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
  });

  it('disables and skips conflicted params when another param is configured', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(() => (
      <ModelParamsDialog
        {...baseProps}
        specs={anthropicSpecs}
        slotLabel="claude-sonnet-4-6"
        current={{ temperature: 0.2, top_p: 0.7 }}
        onSave={onSave}
      />
    ));

    expect(screen.getByRole('slider', { name: 'Top P' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ temperature: 0.2 }));
  });

  it('does not persist nested defaults when only stale inapplicable nested values differ', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(() => (
      <ModelParamsDialog
        {...baseProps}
        specs={anthropicSpecs}
        slotLabel="claude-sonnet-4-6"
        current={{ thinking: { type: 'disabled', budget_tokens: 8192 } }}
        onSave={onSave}
      />
    ));

    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ thinking: { type: 'disabled' } }));
  });

  describe('unset params (issue #3022)', () => {
    const maxTokensSpec = anthropicSpecs.find((spec) => spec.path === 'max_tokens')!;
    const renderMaxTokens = (
      onSave: ReturnType<typeof vi.fn>,
      current: RequestParamDefaults | null = null,
    ) =>
      render(() => (
        <ModelParamsDialog
          {...baseProps}
          specs={[maxTokensSpec]}
          slotLabel="claude-sonnet-4-6"
          current={current}
          onSave={onSave}
        />
      ));

    it('shows an unset field with the provider default as placeholder', () => {
      renderMaxTokens(vi.fn());
      const input = screen.getByLabelText('Max tokens') as HTMLInputElement;
      expect(input.value).toBe('');
      expect(input.placeholder).toBe('4096');
      expect(screen.getByText(/Not set/)).toBeTruthy();
    });

    it('saves nothing when the user leaves the field unset', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined);
      renderMaxTokens(onSave);
      fireEvent.click(screen.getByText('Save'));
      await waitFor(() => expect(onSave).toHaveBeenCalledWith(null));
    });

    it('saves a value equal to the provider default once the user types it', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined);
      renderMaxTokens(onSave);
      fireEvent.input(screen.getByLabelText('Max tokens'), { target: { value: '4096' } });
      expect(screen.getByRole('button', { name: 'Reset Max tokens' })).toBeTruthy();
      fireEvent.click(screen.getByText('Save'));
      await waitFor(() => expect(onSave).toHaveBeenCalledWith({ max_tokens: 4096 }));
    });

    it('shows a stored value that equals the provider default as set', () => {
      renderMaxTokens(vi.fn(), { max_tokens: 4096 });
      expect((screen.getByLabelText('Max tokens') as HTMLInputElement).value).toBe('4096');
      expect(screen.getByRole('button', { name: 'Reset Max tokens' })).toBeTruthy();
    });

    it('unsets the param when the user clears the field', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined);
      renderMaxTokens(onSave, { max_tokens: 8000 });
      fireEvent.input(screen.getByLabelText('Max tokens'), { target: { value: '' } });
      expect(screen.getByText(/Not set/)).toBeTruthy();
      fireEvent.click(screen.getByText('Save'));
      await waitFor(() => expect(onSave).toHaveBeenCalledWith(null));
    });

    it('unsets the param with the Reset button', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined);
      renderMaxTokens(onSave, { max_tokens: 8000 });
      fireEvent.click(screen.getByRole('button', { name: 'Reset Max tokens' }));
      expect((screen.getByLabelText('Max tokens') as HTMLInputElement).value).toBe('');
      fireEvent.click(screen.getByText('Save'));
      await waitFor(() => expect(onSave).toHaveBeenCalledWith(null));
    });

    it('leaves the slider text box empty until the user sets a value', async () => {
      const onSave = vi.fn().mockResolvedValue(undefined);
      render(() => (
        <ModelParamsDialog
          {...baseProps}
          specs={anthropicSpecs}
          slotLabel="claude-sonnet-4-6"
          onSave={onSave}
        />
      ));
      const temperature = screen.getByLabelText('Temperature value') as HTMLInputElement;
      expect(temperature.disabled).toBe(false);
      expect(temperature.value).toBe('');
      expect(temperature.placeholder).toBe('1');

      fireEvent.input(temperature, { target: { value: '0.4' } });
      fireEvent.blur(temperature);
      expect(temperature.value).toBe('0.4');

      fireEvent.input(temperature, { target: { value: '' } });
      fireEvent.blur(temperature);
      expect(temperature.value).toBe('');
      fireEvent.click(screen.getByText('Save'));
      await waitFor(() => expect(onSave).toHaveBeenCalledWith(null));
    });

    it('labels nested siblings the proxy sends with a set root', () => {
      render(() => (
        <ModelParamsDialog
          {...baseProps}
          specs={anthropicSpecs}
          slotLabel="claude-sonnet-4-6"
          current={{ thinking: { type: 'enabled' } }}
        />
      ));
      expect(screen.getByText(/Default sent with thinking/)).toBeTruthy();
    });

    it('shows "Not set" as placeholder when the spec has no default', () => {
      render(() => (
        <ModelParamsDialog
          {...baseProps}
          specs={[{ ...maxTokensSpec, default: undefined }]}
          slotLabel="claude-sonnet-4-6"
        />
      ));
      expect((screen.getByLabelText('Max tokens') as HTMLInputElement).placeholder).toBe('Not set');
    });
  });

  it('cancel button closes without persisting', () => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    render(() => <ModelParamsDialog {...baseProps} onSave={onSave} onClose={onClose} />);

    fireEvent.click(screen.getByText('Cancel'));
    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('Escape key closes the dialog', () => {
    const onClose = vi.fn();
    render(() => <ModelParamsDialog {...baseProps} onClose={onClose} />);
    fireEvent.keyDown(q('.modal-card')!, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('clicking the overlay closes the dialog', () => {
    const onClose = vi.fn();
    render(() => <ModelParamsDialog {...baseProps} onClose={onClose} />);
    fireEvent.click(q('.modal-overlay')!);
    expect(onClose).toHaveBeenCalled();
  });

  it('does not close mid-save when the user re-clicks the overlay', async () => {
    let resolveSave: (() => void) | undefined;
    const onSave = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );
    const onClose = vi.fn();
    render(() => <ModelParamsDialog {...baseProps} onSave={onSave} onClose={onClose} />);

    fireEvent.click(screen.getByText('Save'));
    fireEvent.click(q('.modal-overlay')!);
    expect(onClose).not.toHaveBeenCalled();
    resolveSave!();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
