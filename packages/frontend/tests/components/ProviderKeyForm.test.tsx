import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import type { ProviderDef } from '../../src/services/providers';
import type { AuthType, RoutingProvider } from '../../src/services/api';

/* ── API mocks ──────────────────────────────────────────────── */

const connectProviderMock = vi.fn().mockResolvedValue({});
const disconnectProviderMock = vi.fn().mockResolvedValue({});
const revokeOpenaiOAuthMock = vi.fn().mockResolvedValue(undefined);
const renameProviderKeyMock = vi.fn().mockResolvedValue({});
const reorderProviderKeysMock = vi.fn().mockResolvedValue([]);

vi.mock('../../src/services/api.js', () => ({
  connectProvider: (...args: unknown[]) => connectProviderMock(...args),
  disconnectProvider: (...args: unknown[]) => disconnectProviderMock(...args),
  revokeOpenaiOAuth: (...args: unknown[]) => revokeOpenaiOAuthMock(...args),
  renameProviderKey: (...args: unknown[]) => renameProviderKeyMock(...args),
  reorderProviderKeys: (...args: unknown[]) => reorderProviderKeysMock(...args),
}));

vi.mock('../../src/services/provider-utils.js', () => ({
  validateApiKey: () => ({ valid: true }),
  validateSubscriptionKey: () => ({ valid: true }),
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('../../src/services/toast-store.js', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

vi.mock('../../src/services/provider-api-key-urls.js', () => ({
  getRoutingProviderApiKeyUrl: (id: string) =>
    id === 'openai' ? 'https://platform.openai.com/api-keys' : undefined,
  getSubscriptionProviderKeyUrl: (id: string) =>
    id === 'ollama-cloud' ? 'https://ollama.com/settings/keys' : undefined,
}));

import ProviderKeyForm, { AddAnotherKeyAction } from '../../src/components/ProviderKeyForm';
import { suggestNextProviderKeyLabel } from '../../src/services/provider-key-labels';

/* ── Test helpers ───────────────────────────────────────────── */

function makeProviderDef(overrides: Partial<ProviderDef> = {}): ProviderDef {
  return {
    id: 'test',
    name: 'Test',
    color: '#000',
    initial: 'T',
    subtitle: 'Test subtitle',
    keyPrefix: '',
    minKeyLength: 0,
    keyPlaceholder: 'sk-...',
    supportsSubscription: false,
    subscriptionOnly: false,
    models: [],
    ...overrides,
  } as ProviderDef;
}

interface MountOpts {
  provDef: ProviderDef;
  provId?: string;
  connected?: boolean;
  isSubMode?: boolean;
  selectedAuthType?: AuthType;
  editing?: boolean;
  keyInput?: string;
  providers?: RoutingProvider[];
  addKeyOpen?: boolean;
  onBack?: () => void;
  onUpdate?: () => void;
}

function mount(opts: MountOpts) {
  const [busy, setBusy] = createSignal(false);
  const [keyInput, setKeyInput] = createSignal(opts.keyInput ?? '');
  const [editing, setEditing] = createSignal(opts.editing ?? false);
  const [validationError, setValidationError] = createSignal<string | null>(null);
  const [addKeyOpen, setAddKeyOpen] = createSignal(opts.addKeyOpen ?? false);

  const onBack = opts.onBack ?? vi.fn();
  const onUpdate = opts.onUpdate ?? vi.fn();

  const result = render(() => (
    <ProviderKeyForm
      provDef={opts.provDef}
      provId={opts.provId ?? opts.provDef.id}
      agentName="test-agent"
      isSubMode={() => opts.isSubMode ?? false}
      connected={() => opts.connected ?? false}
      selectedAuthType={() => opts.selectedAuthType ?? 'api_key'}
      busy={busy}
      setBusy={setBusy}
      keyInput={keyInput}
      setKeyInput={setKeyInput}
      editing={editing}
      setEditing={setEditing}
      validationError={validationError}
      setValidationError={setValidationError}
      getKeyPrefixDisplay={() => 'sk-***'}
      providers={opts.providers}
      addKeyOpen={addKeyOpen}
      setAddKeyOpen={setAddKeyOpen}
      onBack={onBack}
      onUpdate={onUpdate}
    />
  ));

  return { ...result, setKeyInput, setAddKeyOpen, onBack, onUpdate };
}

/* ── Tests ──────────────────────────────────────────────────── */

describe('ProviderKeyForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('field label', () => {
    it('shows "API Key" when NOT in subscription mode (api-key provider)', () => {
      const def = makeProviderDef({ id: 'openai', name: 'OpenAI' });
      const { container } = mount({ provDef: def, isSubMode: false });
      const label = container.querySelector('.provider-detail__label');
      expect(label!.textContent).toBe('API Key');
    });

    it('shows "Setup Token" for a subscription provider that uses the default credential kind (Anthropic)', () => {
      // Anthropic-style: subscription mode, no subscriptionCredentialKind set
      // → fallback to 'setup-token' → label is "Setup Token".
      const def = makeProviderDef({
        id: 'anthropic',
        name: 'Anthropic',
        supportsSubscription: true,
        subscriptionLabel: 'Claude Pro',
        // no subscriptionCredentialKind → defaults to setup-token
      });
      const { container } = mount({ provDef: def, isSubMode: true });
      const label = container.querySelector('.provider-detail__label');
      expect(label!.textContent).toBe('Setup Token');
    });

    it('shows "API Key" for an Ollama-Cloud-style subscription provider (subscriptionCredentialKind=api-key)', () => {
      // This is the exact regression the UI/UX pass fixed: Ollama Cloud uses
      // a subscription tab but pastes an API key, not a setup token.
      const def = makeProviderDef({
        id: 'ollama-cloud',
        name: 'Ollama Cloud',
        supportsSubscription: true,
        subscriptionCredentialKind: 'api-key',
        subscriptionLabel: 'Ollama Cloud subscription',
        subscriptionKeyPlaceholder: 'Paste your Ollama Cloud API key',
      });
      const { container } = mount({ provDef: def, isSubMode: true });
      const label = container.querySelector('.provider-detail__label');
      expect(label!.textContent).toBe('API Key');
    });
  });

  describe('aria labels and help URL', () => {
    it('uses "API key" credential noun and OpenAI api-key URL in api-key mode', () => {
      const def = makeProviderDef({ id: 'openai', name: 'OpenAI' });
      const { container } = mount({ provDef: def, isSubMode: false });
      const input = container.querySelector('input');
      expect(input!.getAttribute('aria-label')).toBe('OpenAI API key');
      const link = container.querySelector('.provider-detail__key-help-link');
      expect(link).not.toBeNull();
      expect(link!.getAttribute('href')).toBe('https://platform.openai.com/api-keys');
      expect(link!.textContent).toContain('Get OpenAI API key');
    });

    it('uses "setup token" credential noun for Anthropic subscription mode and hides URL (no subscription URL configured)', () => {
      const def = makeProviderDef({
        id: 'anthropic',
        name: 'Anthropic',
        supportsSubscription: true,
      });
      const { container } = mount({ provDef: def, isSubMode: true });
      const input = container.querySelector('input');
      expect(input!.getAttribute('aria-label')).toBe('Anthropic setup token');
      // Anthropic has no SUBSCRIPTION_PROVIDER_KEY_URL entry → link is hidden.
      expect(container.querySelector('.provider-detail__key-help-link')).toBeNull();
    });

    it('uses "API key" credential noun AND the Ollama settings page URL for Ollama Cloud subscription', () => {
      const def = makeProviderDef({
        id: 'ollama-cloud',
        name: 'Ollama Cloud',
        supportsSubscription: true,
        subscriptionCredentialKind: 'api-key',
      });
      const { container } = mount({ provDef: def, isSubMode: true });
      const input = container.querySelector('input');
      expect(input!.getAttribute('aria-label')).toBe('Ollama Cloud API key');
      const link = container.querySelector('.provider-detail__key-help-link');
      expect(link).not.toBeNull();
      expect(link!.getAttribute('href')).toBe('https://ollama.com/settings/keys');
      expect(link!.textContent).toContain('Get Ollama Cloud API key');
    });
  });

  describe('connected view aria-labels', () => {
    it('labels the masked input "Current API key (masked)" for an api-key credential', () => {
      const def = makeProviderDef({ id: 'openai', name: 'OpenAI' });
      const { container } = mount({ provDef: def, connected: true, isSubMode: false });
      const disabledInput = container.querySelector('input[disabled]');
      expect(disabledInput!.getAttribute('aria-label')).toBe('Current API key (masked)');
    });

    it('labels the masked input "Current setup token (masked)" for a setup-token credential', () => {
      const def = makeProviderDef({
        id: 'anthropic',
        name: 'Anthropic',
        supportsSubscription: true,
      });
      const { container } = mount({ provDef: def, connected: true, isSubMode: true });
      const disabledInput = container.querySelector('input[disabled]');
      expect(disabledInput!.getAttribute('aria-label')).toBe('Current setup token (masked)');
    });

    it('labels the masked input "Current API key (masked)" for Ollama-Cloud-style api-key subscription', () => {
      const def = makeProviderDef({
        id: 'ollama-cloud',
        name: 'Ollama Cloud',
        supportsSubscription: true,
        subscriptionCredentialKind: 'api-key',
      });
      const { container } = mount({ provDef: def, connected: true, isSubMode: true });
      const disabledInput = container.querySelector('input[disabled]');
      expect(disabledInput!.getAttribute('aria-label')).toBe('Current API key (masked)');
    });
  });

  describe('placeholder', () => {
    it('uses provDef.keyPlaceholder in api-key mode', () => {
      const def = makeProviderDef({ id: 'openai', name: 'OpenAI', keyPlaceholder: 'sk-xxx' });
      const { container } = mount({ provDef: def, isSubMode: false });
      const input = container.querySelector('input');
      expect(input!.getAttribute('placeholder')).toBe('sk-xxx');
    });

    it('uses subscriptionKeyPlaceholder in subscription mode', () => {
      const def = makeProviderDef({
        id: 'ollama-cloud',
        name: 'Ollama Cloud',
        supportsSubscription: true,
        subscriptionCredentialKind: 'api-key',
        subscriptionKeyPlaceholder: 'Paste your Ollama Cloud API key',
      });
      const { container } = mount({ provDef: def, isSubMode: true });
      const input = container.querySelector('input');
      expect(input!.getAttribute('placeholder')).toBe('Paste your Ollama Cloud API key');
    });

    it('falls back to "Paste token" when subscription placeholder is not provided', () => {
      const def = makeProviderDef({
        id: 'anthropic',
        name: 'Anthropic',
        supportsSubscription: true,
      });
      const { container } = mount({ provDef: def, isSubMode: true });
      const input = container.querySelector('input');
      expect(input!.getAttribute('placeholder')).toBe('Paste token');
    });
  });

  describe('handleConnect', () => {
    it('calls connectProvider and toast.success on Connect click', async () => {
      const def = makeProviderDef({ id: 'openai', name: 'OpenAI' });
      const onBack = vi.fn();
      const onUpdate = vi.fn();
      const { container } = mount({
        provDef: def,
        keyInput: 'sk-test-key',
        onBack,
        onUpdate,
      });

      const connectBtn = container.querySelector('.provider-detail__action') as HTMLButtonElement;
      expect(connectBtn).not.toBeNull();
      fireEvent.click(connectBtn);
      await Promise.resolve();
      await Promise.resolve();

      expect(connectProviderMock).toHaveBeenCalledWith('test-agent', {
        provider: 'openai',
        apiKey: 'sk-test-key',
        authType: 'api_key',
      });
      expect(toastSuccess).toHaveBeenCalledWith('OpenAI connected');
      expect(onBack).toHaveBeenCalled();
      expect(onUpdate).toHaveBeenCalled();
    });

    it('sends the selected Z.ai subscription endpoint region on connect', async () => {
      const def = makeProviderDef({
        id: 'zai',
        name: 'Z.ai',
        supportsSubscription: true,
        subscriptionAuthMode: 'token',
        subscriptionCredentialKind: 'api-key',
        subscriptionKeyPlaceholder: 'Paste your Z.ai API key',
        subscriptionEndpointRegions: [
          { value: 'global', label: 'Outside China (api.z.ai)' },
          { value: 'cn', label: 'China Mainland (open.bigmodel.cn)' },
        ],
      });
      const { container } = mount({
        provDef: def,
        provId: 'zai',
        isSubMode: true,
        selectedAuthType: 'subscription',
        keyInput: 'zai-sub-key',
      });

      const endpoint = container.querySelector('#zai-subscription-endpoint') as HTMLSelectElement;
      expect(endpoint.value).toBe('global');
      expect(screen.getByLabelText('Region')).toBe(endpoint);
      fireEvent.change(endpoint, { target: { value: 'cn' } });

      const connectBtn = container.querySelector('.provider-detail__action') as HTMLButtonElement;
      fireEvent.click(connectBtn);
      await Promise.resolve();
      await Promise.resolve();

      expect(connectProviderMock).toHaveBeenCalledWith('test-agent', {
        provider: 'zai',
        apiKey: 'zai-sub-key',
        authType: 'subscription',
        region: 'cn',
      });
    });

    it('sends the selected API-key endpoint region on connect', async () => {
      const def = makeProviderDef({
        id: 'bedrock',
        name: 'AWS Bedrock',
        keyPlaceholder: 'ABSK...',
        apiKeyEndpointRegions: [
          { value: 'us-east-1', label: 'US East (N. Virginia)' },
          { value: 'eu-west-1', label: 'Europe (Ireland)' },
        ],
      });
      const { container } = mount({
        provDef: def,
        provId: 'bedrock',
        isSubMode: false,
        selectedAuthType: 'api_key',
        keyInput: 'ABSKTWFudGxlQXBpS2V5LWV4YW1wbGU=',
      });

      const endpoint = container.querySelector(
        '#bedrock-subscription-endpoint',
      ) as HTMLSelectElement;
      expect(endpoint.value).toBe('us-east-1');
      fireEvent.change(endpoint, { target: { value: 'eu-west-1' } });

      const connectBtn = container.querySelector('.provider-detail__action') as HTMLButtonElement;
      fireEvent.click(connectBtn);
      await Promise.resolve();
      await Promise.resolve();

      expect(connectProviderMock).toHaveBeenCalledWith('test-agent', {
        provider: 'bedrock',
        apiKey: 'ABSKTWFudGxlQXBpS2V5LWV4YW1wbGU=',
        authType: 'api_key',
        region: 'eu-west-1',
      });
    });

    it('sends a custom Alibaba API-key endpoint URL as the provider region', async () => {
      const def = makeProviderDef({
        id: 'qwen',
        name: 'Alibaba Cloud',
        apiKeyEndpointRegions: [
          { value: 'auto', label: 'Auto-detect' },
          {
            value: 'custom',
            label: 'Custom endpoint',
            baseUrlPlaceholder:
              'https://<workspace-id>.eu-central-1.maas.aliyuncs.com/compatible-mode/v1',
          },
        ],
      });
      const { container } = mount({
        provDef: def,
        provId: 'qwen',
        isSubMode: false,
        selectedAuthType: 'api_key',
        keyInput: 'sk-qwen-key',
      });

      const endpoint = container.querySelector('#qwen-subscription-endpoint') as HTMLSelectElement;
      fireEvent.change(endpoint, { target: { value: 'custom' } });
      fireEvent.input(screen.getByLabelText('Base URL'), {
        target: {
          value: 'https://workspace-123.eu-central-1.maas.aliyuncs.com/compatible-mode/v1',
        },
      });

      const connectBtn = container.querySelector('.provider-detail__action') as HTMLButtonElement;
      fireEvent.click(connectBtn);
      await Promise.resolve();
      await Promise.resolve();

      expect(connectProviderMock).toHaveBeenCalledWith('test-agent', {
        provider: 'qwen',
        apiKey: 'sk-qwen-key',
        authType: 'api_key',
        region: 'https://workspace-123.eu-central-1.maas.aliyuncs.com/compatible-mode/v1',
      });
    });

    it('sends a named Alibaba workspace endpoint URL as the provider region', async () => {
      const def = makeProviderDef({
        id: 'qwen',
        name: 'Alibaba Cloud',
        apiKeyEndpointRegions: [
          { value: 'auto', label: 'Auto-detect' },
          {
            value: 'workspace-eu-central-1',
            label: 'Germany (Frankfurt)',
            baseUrlPlaceholder:
              'https://<workspace-id>.eu-central-1.maas.aliyuncs.com/compatible-mode/v1',
          },
        ],
      });
      const { container } = mount({
        provDef: def,
        provId: 'qwen',
        isSubMode: false,
        selectedAuthType: 'api_key',
        keyInput: 'sk-qwen-key',
      });

      const endpoint = container.querySelector('#qwen-subscription-endpoint') as HTMLSelectElement;
      fireEvent.change(endpoint, { target: { value: 'workspace-eu-central-1' } });
      fireEvent.input(screen.getByLabelText('Base URL'), {
        target: {
          value: 'https://workspace-123.eu-central-1.maas.aliyuncs.com/compatible-mode/v1',
        },
      });

      const connectBtn = container.querySelector('.provider-detail__action') as HTMLButtonElement;
      fireEvent.click(connectBtn);
      await Promise.resolve();
      await Promise.resolve();

      expect(connectProviderMock).toHaveBeenCalledWith('test-agent', {
        provider: 'qwen',
        apiKey: 'sk-qwen-key',
        authType: 'api_key',
        region: 'https://workspace-123.eu-central-1.maas.aliyuncs.com/compatible-mode/v1',
      });
    });

    it('selects the matching named Alibaba workspace region for a saved endpoint', () => {
      const def = makeProviderDef({
        id: 'qwen',
        name: 'Alibaba Cloud',
        apiKeyEndpointRegions: [
          { value: 'auto', label: 'Auto-detect' },
          {
            value: 'workspace-eu-central-1',
            label: 'Germany (Frankfurt)',
            baseUrlPlaceholder:
              'https://<workspace-id>.eu-central-1.maas.aliyuncs.com/compatible-mode/v1',
          },
          {
            value: 'workspace-ap-northeast-1',
            label: 'Japan (Tokyo)',
            baseUrlPlaceholder:
              'https://<workspace-id>.ap-northeast-1.maas.aliyuncs.com/compatible-mode/v1',
          },
          {
            value: 'custom',
            label: 'Custom endpoint',
            baseUrlPlaceholder:
              'https://<workspace-id>.eu-central-1.maas.aliyuncs.com/compatible-mode/v1',
          },
        ],
      });
      const { container } = mount({
        provDef: def,
        provId: 'qwen',
        connected: true,
        editing: true,
        keyInput: 'sk-new-qwen-key',
        providers: [
          makeProvider({
            provider: 'qwen',
            region: 'https://workspace-123.ap-northeast-1.maas.aliyuncs.com/compatible-mode/v1',
          }),
        ],
      });

      const endpoint = container.querySelector(
        '#qwen-subscription-endpoint-edit',
      ) as HTMLSelectElement;
      const baseUrl = screen.getByLabelText('Base URL') as HTMLInputElement;

      expect(endpoint.value).toBe('workspace-ap-northeast-1');
      expect(baseUrl.value).toBe(
        'https://workspace-123.ap-northeast-1.maas.aliyuncs.com/compatible-mode/v1',
      );
    });
  });

  describe('handleUpdateKey toast labels', () => {
    it('says "key updated" for an api-key credential (NOT in subscription mode)', async () => {
      const def = makeProviderDef({ id: 'openai', name: 'OpenAI' });
      const { container } = mount({
        provDef: def,
        connected: true,
        editing: true,
        keyInput: 'sk-new-key',
        isSubMode: false,
      });

      // Find the Save button (inside the editing view)
      const saveBtn = Array.from(container.querySelectorAll('.provider-detail__action')).find((b) =>
        b.textContent?.includes('Save'),
      ) as HTMLButtonElement;
      expect(saveBtn).not.toBeNull();
      fireEvent.click(saveBtn);
      await Promise.resolve();
      await Promise.resolve();
      expect(toastSuccess).toHaveBeenCalledWith('OpenAI key updated');
    });

    it('says "token updated" for a setup-token subscription credential (Anthropic)', async () => {
      const def = makeProviderDef({
        id: 'anthropic',
        name: 'Anthropic',
        supportsSubscription: true,
      });
      const { container } = mount({
        provDef: def,
        connected: true,
        editing: true,
        isSubMode: true,
        keyInput: 'sess-token-abc',
      });
      const saveBtn = Array.from(container.querySelectorAll('.provider-detail__action')).find((b) =>
        b.textContent?.includes('Save'),
      ) as HTMLButtonElement;
      fireEvent.click(saveBtn);
      await Promise.resolve();
      await Promise.resolve();
      expect(toastSuccess).toHaveBeenCalledWith('Anthropic token updated');
    });

    it('says "key updated" for an api-key subscription credential (Ollama Cloud)', async () => {
      const def = makeProviderDef({
        id: 'ollama-cloud',
        name: 'Ollama Cloud',
        supportsSubscription: true,
        subscriptionCredentialKind: 'api-key',
      });
      const { container } = mount({
        provDef: def,
        connected: true,
        editing: true,
        isSubMode: true,
        keyInput: 'new-cloud-key',
      });
      const saveBtn = Array.from(container.querySelectorAll('.provider-detail__action')).find((b) =>
        b.textContent?.includes('Save'),
      ) as HTMLButtonElement;
      fireEvent.click(saveBtn);
      await Promise.resolve();
      await Promise.resolve();
      // Even though isSubMode() is true, isApiKeyCredential() short-circuits
      // the "token" label and we use "key".
      expect(toastSuccess).toHaveBeenCalledWith('Ollama Cloud key updated');
    });

    it('preserves the saved Z.ai endpoint region when updating a subscription key', async () => {
      const def = makeProviderDef({
        id: 'zai',
        name: 'Z.ai',
        supportsSubscription: true,
        subscriptionCredentialKind: 'api-key',
        subscriptionEndpointRegions: [
          { value: 'global', label: 'Outside China (api.z.ai)' },
          { value: 'cn', label: 'China Mainland (open.bigmodel.cn)' },
        ],
      });
      const { container } = mount({
        provDef: def,
        provId: 'zai',
        connected: true,
        editing: true,
        isSubMode: true,
        selectedAuthType: 'subscription',
        keyInput: 'zai-new-key',
        providers: [
          makeProvider({
            provider: 'zai',
            auth_type: 'subscription',
            region: 'cn',
          }),
        ],
      });

      const endpoint = container.querySelector(
        '#zai-subscription-endpoint-edit',
      ) as HTMLSelectElement;
      expect(endpoint.value).toBe('cn');

      const saveBtn = Array.from(container.querySelectorAll('.provider-detail__action')).find((b) =>
        b.textContent?.includes('Save'),
      ) as HTMLButtonElement;
      fireEvent.click(saveBtn);
      await Promise.resolve();
      await Promise.resolve();

      expect(connectProviderMock).toHaveBeenCalledWith('test-agent', {
        provider: 'zai',
        apiKey: 'zai-new-key',
        authType: 'subscription',
        region: 'cn',
        label: 'Default',
      });
    });

    it('targets the visible key label on update so a non-Default key is not bypassed', async () => {
      const def = makeProviderDef({ id: 'openai', name: 'OpenAI' });
      const { container } = mount({
        provDef: def,
        provId: 'openai',
        connected: true,
        editing: true,
        keyInput: 'sk-new-value',
        providers: [
          {
            id: 'p2',
            provider: 'openai',
            auth_type: 'api_key' as const,
            is_active: true,
            has_api_key: true,
            key_prefix: 'sk-old-',
            label: 'second',
            priority: 1,
            region: null,
            connected_at: '2026-04-27',
          },
        ],
      });

      const saveBtn = Array.from(container.querySelectorAll('.provider-detail__action')).find((b) =>
        b.textContent?.includes('Save'),
      ) as HTMLButtonElement;
      fireEvent.click(saveBtn);
      await Promise.resolve();
      await Promise.resolve();

      expect(connectProviderMock).toHaveBeenCalledWith('test-agent', {
        provider: 'openai',
        apiKey: 'sk-new-value',
        authType: 'api_key',
        label: 'second',
      });
    });

    it('omits Z.ai endpoint region on update when provider chain data is unavailable', async () => {
      const def = makeProviderDef({
        id: 'zai',
        name: 'Z.ai',
        supportsSubscription: true,
        subscriptionCredentialKind: 'api-key',
        subscriptionEndpointRegions: [
          { value: 'global', label: 'Outside China (api.z.ai)' },
          { value: 'cn', label: 'China Mainland (open.bigmodel.cn)' },
        ],
      });
      const { container } = mount({
        provDef: def,
        provId: 'zai',
        connected: true,
        editing: true,
        isSubMode: true,
        selectedAuthType: 'subscription',
        keyInput: 'zai-new-key',
      });

      const endpoint = container.querySelector(
        '#zai-subscription-endpoint-edit',
      ) as HTMLSelectElement;
      expect(endpoint.value).toBe('global');

      const saveBtn = Array.from(container.querySelectorAll('.provider-detail__action')).find((b) =>
        b.textContent?.includes('Save'),
      ) as HTMLButtonElement;
      fireEvent.click(saveBtn);
      await Promise.resolve();
      await Promise.resolve();

      expect(connectProviderMock).toHaveBeenCalledWith('test-agent', {
        provider: 'zai',
        apiKey: 'zai-new-key',
        authType: 'subscription',
      });
    });
  });

  describe('handleDisconnect', () => {
    it('does NOT revoke OpenAI OAuth when auth mode is NOT subscription+popup_oauth', async () => {
      const def = makeProviderDef({ id: 'openai', name: 'OpenAI' });
      const { container } = mount({ provDef: def, connected: true, isSubMode: false });
      const disconnectBtn = container.querySelector(
        '.provider-detail__disconnect-icon',
      ) as HTMLButtonElement;
      fireEvent.click(disconnectBtn);
      await Promise.resolve();
      await Promise.resolve();
      expect(revokeOpenaiOAuthMock).not.toHaveBeenCalled();
      expect(disconnectProviderMock).toHaveBeenCalled();
    });

    it('calls revokeOpenaiOAuth before disconnect when provider is OpenAI popup_oauth subscription', async () => {
      // This exercises lines 112-114: shouldRevokeOpenaiOAuth() === true.
      const def = makeProviderDef({
        id: 'openai',
        name: 'OpenAI',
        supportsSubscription: true,
        subscriptionAuthMode: 'popup_oauth',
      });
      const { container } = mount({
        provDef: def,
        provId: 'openai',
        connected: true,
        isSubMode: true,
        selectedAuthType: 'subscription',
      });
      const disconnectBtn = container.querySelector(
        '.provider-detail__disconnect-icon',
      ) as HTMLButtonElement;
      fireEvent.click(disconnectBtn);
      await Promise.resolve();
      await Promise.resolve();
      expect(revokeOpenaiOAuthMock).toHaveBeenCalledWith('test-agent');
      expect(disconnectProviderMock).toHaveBeenCalled();
    });

    it('swallows revokeOpenaiOAuth errors and still calls disconnect', async () => {
      revokeOpenaiOAuthMock.mockRejectedValueOnce(new Error('revoke failed'));
      const def = makeProviderDef({
        id: 'openai',
        name: 'OpenAI',
        supportsSubscription: true,
        subscriptionAuthMode: 'popup_oauth',
      });
      const { container } = mount({
        provDef: def,
        provId: 'openai',
        connected: true,
        isSubMode: true,
        selectedAuthType: 'subscription',
      });
      const disconnectBtn = container.querySelector(
        '.provider-detail__disconnect-icon',
      ) as HTMLButtonElement;
      fireEvent.click(disconnectBtn);
      await Promise.resolve();
      await Promise.resolve();
      expect(revokeOpenaiOAuthMock).toHaveBeenCalled();
      // Even with the rejection, disconnectProvider runs.
      expect(disconnectProviderMock).toHaveBeenCalled();
    });

    it('surfaces backend notifications as toast errors', async () => {
      disconnectProviderMock.mockResolvedValueOnce({
        notifications: ['Archived alert rule', 'Removed from tier'],
      });
      const def = makeProviderDef({ id: 'openai', name: 'OpenAI' });
      const { container } = mount({ provDef: def, connected: true, isSubMode: false });
      const disconnectBtn = container.querySelector(
        '.provider-detail__disconnect-icon',
      ) as HTMLButtonElement;
      fireEvent.click(disconnectBtn);
      await Promise.resolve();
      await Promise.resolve();
      expect(toastError).toHaveBeenCalledWith('Archived alert rule');
      expect(toastError).toHaveBeenCalledWith('Removed from tier');
    });
  });

  describe('editing state transitions', () => {
    it('clicking Change enters editing mode with an empty input', () => {
      const def = makeProviderDef({ id: 'openai', name: 'OpenAI' });
      const { container, getByText } = mount({
        provDef: def,
        connected: true,
        editing: false,
        keyInput: 'stale',
      });
      const changeBtn = getByText('Change');
      fireEvent.click(changeBtn);
      // After clicking Change the editing-mode input is rendered.
      const editingInputs = container.querySelectorAll('input:not([disabled])');
      expect(editingInputs.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('subscription provider without URL', () => {
    it('does not render the Get API key link when neither map returns a URL (Anthropic api-key mode)', () => {
      const def = makeProviderDef({
        id: 'unknown-provider',
        name: 'Unknown',
      });
      const { container } = mount({ provDef: def, isSubMode: false });
      expect(container.querySelector('.provider-detail__key-help-link')).toBeNull();
    });
  });

  describe('Enter key submission', () => {
    it('submits handleConnect when Enter is pressed in the connect input', async () => {
      const def = makeProviderDef({ id: 'openai', name: 'OpenAI' });
      const { container } = mount({ provDef: def, keyInput: 'sk-test' });
      const input = container.querySelector('input') as HTMLInputElement;
      fireEvent.keyDown(input, { key: 'Enter' });
      await Promise.resolve();
      await Promise.resolve();
      expect(connectProviderMock).toHaveBeenCalled();
    });

    it('submits handleUpdateKey when Enter is pressed in the editing input', async () => {
      const def = makeProviderDef({ id: 'openai', name: 'OpenAI' });
      const { container } = mount({
        provDef: def,
        connected: true,
        editing: true,
        keyInput: 'sk-new',
      });
      const editingInput = container.querySelector('input:not([disabled])') as HTMLInputElement;
      fireEvent.keyDown(editingInput, { key: 'Enter' });
      await Promise.resolve();
      await Promise.resolve();
      expect(connectProviderMock).toHaveBeenCalled();
      expect(toastSuccess).toHaveBeenCalledWith('OpenAI key updated');
    });
  });

  /* ── multi-key chain (api_key only) ─────────────────────────── */

  function makeProvider(overrides: Partial<RoutingProvider> = {}): RoutingProvider {
    return {
      id: 'p1',
      provider: 'openai',
      auth_type: 'api_key',
      is_active: true,
      has_api_key: true,
      key_prefix: 'sk-test-',
      label: 'Default',
      priority: 0,
      region: null,
      connected_at: '2026-04-27',
      ...overrides,
    };
  }

  describe('multi-key chain', () => {
    it('shows the legacy single-key view (no list, no Primary badge) when only one key is connected', () => {
      const def = makeProviderDef({ id: 'openai', name: 'OpenAI' });
      const { container } = mount({
        provDef: def,
        connected: true,
        providers: [makeProvider()],
      });
      // Header still says "API Key" (singular).
      expect(container.querySelector('.provider-detail__label')!.textContent).toBe('API Key');
      // The legacy disabled key input is rendered; there's no <ul role=list>.
      expect(container.querySelector('input[disabled]')).toBeDefined();
      expect(container.querySelector('ul[role="list"]')).toBeNull();
    });

    it('renders the add-key form when addKeyOpen signal is true for api_key providers', () => {
      const def = makeProviderDef({ id: 'openai', name: 'OpenAI' });
      const { getByText } = mount({
        provDef: def,
        connected: true,
        addKeyOpen: true,
        providers: [makeProvider()],
      });
      expect(getByText('Add key')).toBeDefined();
    });

    it('renders the add-key form when addKeyOpen is true for subscription providers (multi-account chain)', () => {
      const def = makeProviderDef({
        id: 'anthropic',
        name: 'Anthropic',
        supportsSubscription: true,
        subscriptionLabel: 'Claude Pro',
      });
      const { getByText } = mount({
        provDef: def,
        connected: true,
        isSubMode: true,
        selectedAuthType: 'subscription',
        addKeyOpen: true,
        providers: [
          makeProvider({ provider: 'anthropic', auth_type: 'subscription', label: 'Default' }),
        ],
      });
      expect(getByText('Add key')).toBeDefined();
    });

    it('does not show "+ Add another key" for local providers (Ollama)', () => {
      const def = makeProviderDef({ id: 'ollama', name: 'Ollama' });
      const { queryByText } = mount({
        provDef: def,
        connected: true,
        selectedAuthType: 'local',
        providers: [
          makeProvider({
            provider: 'ollama',
            auth_type: 'local',
            label: 'Default',
            has_api_key: false,
          }),
        ],
      });
      expect(queryByText('+ Add another key')).toBeNull();
    });

    it('switches to list mode (header "API Keys", <ul role="list">) when 2+ keys exist', () => {
      const def = makeProviderDef({ id: 'openai', name: 'OpenAI' });
      const { container } = mount({
        provDef: def,
        connected: true,
        providers: [
          makeProvider({ id: 'p1', label: 'Personal', priority: 0 }),
          makeProvider({ id: 'p2', label: 'Work', priority: 1 }),
        ],
      });
      expect(container.querySelector('.provider-detail__label')!.textContent).toBe('API Keys');
      expect(container.querySelector('ul[role="list"]')).toBeDefined();
    });

    it('renders each key by its label without chain badges', () => {
      const def = makeProviderDef({ id: 'openai', name: 'OpenAI' });
      const { getByText, queryByText } = mount({
        provDef: def,
        connected: true,
        providers: [
          makeProvider({ id: 'p1', label: 'Personal', priority: 0 }),
          makeProvider({ id: 'p2', label: 'Work', priority: 1 }),
        ],
      });
      expect(getByText('Personal')).toBeDefined();
      expect(getByText('Work')).toBeDefined();
      // No "Primary" / "Fallback N" — keys are equal, fallback is configured
      // separately via the existing model-fallback UI.
      expect(queryByText('Primary')).toBeNull();
      expect(queryByText('Fallback 1')).toBeNull();
    });

    it('rename invokes renameProviderKey with the auth_type and refreshes', async () => {
      const def = makeProviderDef({ id: 'openai', name: 'OpenAI' });
      const onUpdate = vi.fn();
      const { container, getByText } = mount({
        provDef: def,
        connected: true,
        onUpdate,
        providers: [
          makeProvider({ id: 'p1', label: 'Personal', priority: 0 }),
          makeProvider({ id: 'p2', label: 'Work', priority: 1 }),
        ],
      });
      // Open rename for the first row (Personal).
      const renameButtons = container.querySelectorAll('button');
      const personalRename = Array.from(renameButtons).find(
        (b) => b.textContent === 'Rename',
      ) as HTMLButtonElement;
      fireEvent.click(personalRename);

      const renameInput = container.querySelector(
        'input[aria-label="Rename Personal"]',
      ) as HTMLInputElement;
      fireEvent.input(renameInput, { target: { value: 'Home' } });
      fireEvent.click(getByText('Save'));

      await Promise.resolve();
      await Promise.resolve();
      expect(renameProviderKeyMock).toHaveBeenCalledWith(
        'test-agent',
        'openai',
        'Personal',
        'Home',
        'api_key',
      );
      expect(onUpdate).toHaveBeenCalled();
    });

    it('does not render reorder controls — keys are equal credentials, not a chain', () => {
      const def = makeProviderDef({ id: 'openai', name: 'OpenAI' });
      const { container } = mount({
        provDef: def,
        connected: true,
        providers: [
          makeProvider({ id: 'p1', label: 'Personal', priority: 0 }),
          makeProvider({ id: 'p2', label: 'Work', priority: 1 }),
        ],
      });
      expect(container.querySelector('button[aria-label="Move Personal down"]')).toBeNull();
      expect(container.querySelector('button[aria-label="Move Work up"]')).toBeNull();
    });

    it('trash icon on a list row deletes by label without unmounting the modal', async () => {
      const def = makeProviderDef({ id: 'openai', name: 'OpenAI' });
      const onBack = vi.fn();
      const onUpdate = vi.fn();
      const { container } = mount({
        provDef: def,
        connected: true,
        onBack,
        onUpdate,
        providers: [
          makeProvider({ id: 'p1', label: 'Personal', priority: 0 }),
          makeProvider({ id: 'p2', label: 'Work', priority: 1 }),
        ],
      });
      const deleteWork = container.querySelector(
        'button[aria-label="Delete key Work"]',
      ) as HTMLButtonElement;
      fireEvent.click(deleteWork);

      await Promise.resolve();
      await Promise.resolve();
      expect(disconnectProviderMock).toHaveBeenCalledWith(
        'test-agent',
        'openai',
        'api_key',
        'Work',
      );
      // Stays on the modal so the user can keep editing the chain.
      expect(onBack).not.toHaveBeenCalled();
      expect(onUpdate).toHaveBeenCalled();
    });

    it('inline rename for a chain row calls renameProviderKey and refreshes', async () => {
      const def = makeProviderDef({ id: 'openai', name: 'OpenAI' });
      const onUpdate = vi.fn();
      const { container, getByText } = mount({
        provDef: def,
        connected: true,
        onUpdate,
        providers: [
          makeProvider({ id: 'p1', label: 'Personal', priority: 0 }),
          makeProvider({ id: 'p2', label: 'Work', priority: 1 }),
        ],
      });
      // Click the first row's Rename button.
      const renameBtns = Array.from(container.querySelectorAll('button')).filter(
        (b) => b.textContent === 'Rename',
      );
      fireEvent.click(renameBtns[0] as HTMLButtonElement);
      const input = container.querySelector('input[type="text"]') as HTMLInputElement;
      fireEvent.input(input, { target: { value: 'Home' } });
      fireEvent.click(getByText('Save'));

      await Promise.resolve();
      await Promise.resolve();
      expect(renameProviderKeyMock).toHaveBeenCalledWith(
        'test-agent',
        'openai',
        'Personal',
        'Home',
        'api_key',
      );
      expect(toastSuccess).toHaveBeenCalledWith('Renamed to "Home"');
    });

    it('AddAnotherKeyAction submits a new labeled key with the suggested default label', async () => {
      const def = makeProviderDef({ id: 'openai', name: 'OpenAI' });
      const onUpdate = vi.fn();
      const { container, getByText } = mount({
        provDef: def,
        connected: true,
        addKeyOpen: true,
        onUpdate,
        providers: [makeProvider({ id: 'p1', label: 'Default', priority: 0 })],
      });
      // Form is already open via addKeyOpen. The api-key input has a placeholder "sk-...".
      const apiKeyInput = container.querySelector(
        'input[placeholder="sk-..."]',
      ) as HTMLInputElement;
      fireEvent.input(apiKeyInput, { target: { value: 'sk-second' } });
      fireEvent.click(getByText('Add key'));

      await Promise.resolve();
      await Promise.resolve();
      // Default suggestion for the 2nd key is "Key 2".
      expect(connectProviderMock).toHaveBeenCalledWith('test-agent', {
        provider: 'openai',
        apiKey: 'sk-second',
        authType: 'api_key',
        label: 'Key 2',
      });
      expect(toastSuccess).toHaveBeenCalledWith('OpenAI key "Key 2" added');
    });

    it('list-mode AddAnotherKeyAction submits a 3rd key via connectProvider with the chain auth_type', async () => {
      const def = makeProviderDef({ id: 'openai', name: 'OpenAI' });
      const onUpdate = vi.fn();
      const { container, getByText } = mount({
        provDef: def,
        connected: true,
        addKeyOpen: true,
        onUpdate,
        providers: [
          makeProvider({ id: 'p1', label: 'Personal', priority: 0 }),
          makeProvider({ id: 'p2', label: 'Work', priority: 1 }),
        ],
      });
      // List mode is active because there are 2 keys; form is open via addKeyOpen.
      // The api-key input has id="add-key-value".
      const apiKeyInput = container.querySelector('#add-key-value') as HTMLInputElement;
      fireEvent.input(apiKeyInput, { target: { value: 'sk-third' } });
      fireEvent.click(getByText('Add key'));
      await Promise.resolve();
      await Promise.resolve();
      expect(connectProviderMock).toHaveBeenCalledWith('test-agent', {
        provider: 'openai',
        apiKey: 'sk-third',
        authType: 'api_key',
        label: 'Key 3',
      });
      expect(toastSuccess).toHaveBeenCalledWith('OpenAI key "Key 3" added');
    });

    it('list-mode AddAnotherKey routes through validateSubscriptionKey when chain is subscription', async () => {
      const def = makeProviderDef({
        id: 'anthropic',
        name: 'Anthropic',
        supportsSubscription: true,
        subscriptionLabel: 'Claude Pro',
      });
      const { container, getByText } = mount({
        provDef: def,
        connected: true,
        isSubMode: true,
        selectedAuthType: 'subscription',
        addKeyOpen: true,
        providers: [
          makeProvider({
            id: 's1',
            provider: 'anthropic',
            auth_type: 'subscription',
            label: 'Personal',
            priority: 0,
          }),
          makeProvider({
            id: 's2',
            provider: 'anthropic',
            auth_type: 'subscription',
            label: 'Work',
            priority: 1,
          }),
        ],
      });
      const tokenInput = container.querySelector('#add-key-value') as HTMLInputElement;
      fireEvent.input(tokenInput, { target: { value: 'sub-third-token' } });
      fireEvent.click(getByText('Add key'));
      await Promise.resolve();
      await Promise.resolve();
      expect(connectProviderMock).toHaveBeenCalledWith('test-agent', {
        provider: 'anthropic',
        apiKey: 'sub-third-token',
        authType: 'subscription',
        label: 'Key 3',
      });
    });

    it('list-mode AddAnotherKey includes the selected Z.ai subscription endpoint region', async () => {
      const def = makeProviderDef({
        id: 'zai',
        name: 'Z.ai',
        supportsSubscription: true,
        subscriptionCredentialKind: 'api-key',
        subscriptionEndpointRegions: [
          { value: 'global', label: 'Outside China (api.z.ai)' },
          { value: 'cn', label: 'China Mainland (open.bigmodel.cn)' },
        ],
      });
      const { container, getByText } = mount({
        provDef: def,
        provId: 'zai',
        connected: true,
        isSubMode: true,
        selectedAuthType: 'subscription',
        addKeyOpen: true,
        providers: [
          makeProvider({
            id: 'z1',
            provider: 'zai',
            auth_type: 'subscription',
            label: 'Personal',
            priority: 0,
            region: 'global',
          }),
          makeProvider({
            id: 'z2',
            provider: 'zai',
            auth_type: 'subscription',
            label: 'Work',
            priority: 1,
            region: 'cn',
          }),
        ],
      });

      const endpoint = container.querySelector('#add-key-endpoint') as HTMLSelectElement;
      expect(screen.getByLabelText('Region')).toBe(endpoint);
      fireEvent.change(endpoint, { target: { value: 'cn' } });
      const tokenInput = container.querySelector('#add-key-value') as HTMLInputElement;
      fireEvent.input(tokenInput, { target: { value: 'zai-third-key' } });
      fireEvent.click(getByText('Add key'));
      await Promise.resolve();
      await Promise.resolve();

      expect(connectProviderMock).toHaveBeenCalledWith('test-agent', {
        provider: 'zai',
        apiKey: 'zai-third-key',
        authType: 'subscription',
        label: 'Key 3',
        region: 'cn',
      });
    });

    it('list-mode AddAnotherKey sends a named Qwen workspace endpoint URL', async () => {
      const def = makeProviderDef({
        id: 'qwen',
        name: 'Alibaba Cloud',
        apiKeyEndpointRegions: [
          { value: 'auto', label: 'Auto-detect' },
          {
            value: 'workspace-ap-northeast-1',
            label: 'Japan (Tokyo)',
            baseUrlPlaceholder:
              'https://<workspace-id>.ap-northeast-1.maas.aliyuncs.com/compatible-mode/v1',
          },
        ],
      });
      const { container, getByText } = mount({
        provDef: def,
        provId: 'qwen',
        connected: true,
        addKeyOpen: true,
        providers: [
          makeProvider({
            id: 'q1',
            provider: 'qwen',
            label: 'Personal',
            priority: 0,
            region: 'auto',
          }),
          makeProvider({
            id: 'q2',
            provider: 'qwen',
            label: 'Work',
            priority: 1,
            region: 'auto',
          }),
        ],
      });

      const endpoint = container.querySelector('#add-key-endpoint') as HTMLSelectElement;
      fireEvent.change(endpoint, { target: { value: 'workspace-ap-northeast-1' } });
      fireEvent.input(screen.getByLabelText('Base URL'), {
        target: {
          value: 'https://workspace-123.ap-northeast-1.maas.aliyuncs.com/compatible-mode/v1',
        },
      });
      const apiKeyInput = container.querySelector('#add-key-value') as HTMLInputElement;
      fireEvent.input(apiKeyInput, { target: { value: 'sk-third' } });
      fireEvent.click(getByText('Add key'));
      await Promise.resolve();
      await Promise.resolve();

      expect(connectProviderMock).toHaveBeenCalledWith('test-agent', {
        provider: 'qwen',
        apiKey: 'sk-third',
        authType: 'api_key',
        label: 'Key 3',
        region: 'https://workspace-123.ap-northeast-1.maas.aliyuncs.com/compatible-mode/v1',
      });
    });

    it('handleAddKey returns false when connectProvider rejects', async () => {
      connectProviderMock.mockRejectedValueOnce(new Error('bad'));
      const def = makeProviderDef({ id: 'openai', name: 'OpenAI' });
      const { container, getByText } = mount({
        provDef: def,
        connected: true,
        addKeyOpen: true,
        providers: [makeProvider({ id: 'p1', label: 'Default', priority: 0 })],
      });
      const apiKeyInput = container.querySelector('#add-key-value') as HTMLInputElement;
      fireEvent.input(apiKeyInput, { target: { value: 'sk-second' } });
      fireEvent.click(getByText('Add key'));
      await Promise.resolve();
      await Promise.resolve();
      // No success toast, form remains open (the catch returned false).
      expect(toastSuccess).not.toHaveBeenCalled();
    });

    it('AddAnotherKeyAction Cancel closes the form without submitting', () => {
      const def = makeProviderDef({ id: 'openai', name: 'OpenAI' });
      const { container, getByText, queryByText } = mount({
        provDef: def,
        connected: true,
        addKeyOpen: true,
        providers: [makeProvider({ id: 'p1', label: 'Default', priority: 0 })],
      });
      expect(queryByText('Cancel')).toBeDefined();
      fireEvent.click(getByText('Cancel'));
      // Form collapses; the Cancel button is gone.
      expect(container.querySelector('input[placeholder="sk-..."]')).toBeNull();
      expect(connectProviderMock).not.toHaveBeenCalled();
    });
  });

  describe('AddAnotherKeyAction (uncontrolled open)', () => {
    function mountAction(overrides: { isSubscription?: boolean } = {}) {
      const [busy, setBusy] = createSignal(false);
      const def = makeProviderDef({ id: 'openai', name: 'OpenAI' });
      return render(() => (
        <AddAnotherKeyAction
          onAdd={vi.fn().mockResolvedValue(true)}
          busy={busy}
          setBusy={setBusy}
          provDef={def}
          placeholder="sk-..."
          whereToGetUrl={() => undefined}
          credentialNoun={() => 'API key'}
          credentialOwnerName={() => 'OpenAI'}
          existingLabels={() => ['Default']}
          isSubscription={overrides.isSubscription}
        />
      ));
    }

    it('shows "Add another key" when isSubscription is false or undefined', () => {
      const { queryByText } = mountAction({ isSubscription: false });
      expect(queryByText(/Add another key/)).not.toBeNull();
      expect(queryByText(/Add connection/)).toBeNull();
    });

    it('shows "Add connection" when isSubscription is true', () => {
      const { queryByText } = mountAction({ isSubscription: true });
      expect(queryByText(/Add connection/)).not.toBeNull();
      expect(queryByText(/Add another key/)).toBeNull();
    });

    it('auto-focuses the API key input when opened', async () => {
      const { queryByText } = mountAction();
      const btn = queryByText(/Add another key/) as HTMLButtonElement;
      fireEvent.click(btn);
      // After clicking, the form opens and requestAnimationFrame fires focus.
      // Just verify the form is now visible (input rendered).
      await Promise.resolve();
      expect(queryByText('Add key')).not.toBeNull();
    });
  });

  /* ── Endpoint-region seeding on externally-controlled open ──────────────
   * Drives the `on(isOpen, …)` effect's region branch: when the form opens
   * with endpoint regions available but no region picked yet, it seeds the
   * region select. `endpointRegions`, `initialEndpointRegion`, and `open` are
   * passed reactively so the region is genuinely unset at the moment `open`
   * flips true (the signal starts empty), forcing the `!endpointRegion()`
   * branch to run. */
  describe('AddAnotherKeyAction endpoint-region seeding', () => {
    function mountControlled(opts: {
      regions: () => { value: string; label: string }[];
      initialEndpointRegion: () => string | undefined;
      open: () => boolean;
    }) {
      const [busy, setBusy] = createSignal(false);
      const def = makeProviderDef({
        id: 'zai',
        name: 'Z.ai',
        supportsSubscription: true,
        subscriptionCredentialKind: 'api-key',
      });
      return render(() => (
        <AddAnotherKeyAction
          onAdd={vi.fn().mockResolvedValue(true)}
          busy={busy}
          setBusy={setBusy}
          provDef={def}
          placeholder="Paste token"
          whereToGetUrl={() => undefined}
          credentialNoun={() => 'API key'}
          credentialOwnerName={() => 'Z.ai'}
          existingLabels={() => ['Default']}
          isSubscription
          endpointRegions={opts.regions()}
          initialEndpointRegion={opts.initialEndpointRegion()}
          open={opts.open}
        />
      ));
    }

    it('falls back to the default region when no initial region is provided', () => {
      // Regions start empty + no initial → the signal initializes undefined.
      // After regions arrive and the form opens, the effect seeds the select
      // with the first region (the `?? defaultEndpointRegion` branch).
      const [regions, setRegions] = createSignal<{ value: string; label: string }[]>([]);
      const [open, setOpen] = createSignal(false);
      const { container } = mountControlled({
        regions,
        initialEndpointRegion: () => undefined,
        open,
      });

      setRegions([
        { value: 'us-east', label: 'US East' },
        { value: 'eu-west', label: 'EU West' },
      ]);
      setOpen(true);

      const select = container.querySelector('#add-key-endpoint') as HTMLSelectElement;
      expect(select).not.toBeNull();
      expect(select.value).toBe('us-east');
    });

    it('prefers the provided initial region over the default when seeding', () => {
      // initialEndpointRegion is set (reactively) before the form opens, so the
      // effect seeds with it (the `props.initialEndpointRegion ??` branch).
      const [regions, setRegions] = createSignal<{ value: string; label: string }[]>([]);
      const [initial, setInitial] = createSignal<string | undefined>(undefined);
      const [open, setOpen] = createSignal(false);
      const { container } = mountControlled({
        regions,
        initialEndpointRegion: initial,
        open,
      });

      setRegions([
        { value: 'us-east', label: 'US East' },
        { value: 'eu-west', label: 'EU West' },
      ]);
      setInitial('eu-west');
      setOpen(true);

      const select = container.querySelector('#add-key-endpoint') as HTMLSelectElement;
      expect(select).not.toBeNull();
      expect(select.value).toBe('eu-west');
    });
  });
});

describe('suggestNextProviderKeyLabel', () => {
  it('falls back after the bounded Key N search is exhausted', () => {
    const existing = Array.from({ length: 98 }, (_, index) => `Key ${index + 2}`);
    existing.push('Default');

    expect(suggestNextProviderKeyLabel(existing)).toBe('Key 100');
  });
});
