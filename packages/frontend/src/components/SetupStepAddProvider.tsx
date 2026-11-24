import { createSignal, createMemo, Show, Switch, Match, type Component } from 'solid-js';
import FrameworkSnippets from './FrameworkSnippets.jsx';
import OpenClawSetup from './OpenClawSetup.jsx';
import HermesSetup from './HermesSetup.jsx';
import NanobotSetup from './NanobotSetup.jsx';
import CraftAgentSetup from './CraftAgentSetup.jsx';
import N8nSetup from './N8nSetup.jsx';
import ClaudeCodeSetup from './ClaudeCodeSetup.jsx';
import OpenCodeSetup from './OpenCodeSetup.jsx';
import CodexSetup from './CodexSetup.jsx';
import type { ToolkitId } from '../services/framework-snippets.js';

type SetupTab = 'toolkits' | 'agents';
type AgentId = 'openclaw' | 'hermes' | 'nanobot' | 'craft' | 'claude-code' | 'opencode' | 'codex';

interface Props {
  apiKey: string | null;
  keyPrefix: string | null;
  baseUrl: string;
  hideFullKey?: boolean;
  platform?: string | null;
}

const PLATFORM_TO_TOOLKIT: Record<string, ToolkitId> = {
  'openai-sdk': 'openai-sdk',
  'anthropic-sdk': 'anthropic-sdk',
  'vercel-ai-sdk': 'vercel-ai-sdk',
  langchain: 'langchain',
  curl: 'curl',
};

const SetupStepAddProvider: Component<Props> = (props) => {
  const [activeTab, setActiveTab] = createSignal<SetupTab>('agents');
  const [activeAgent, setActiveAgent] = createSignal<AgentId>('openclaw');

  const snippetProps = createMemo(() => ({
    apiKey: props.apiKey,
    keyPrefix: props.keyPrefix,
    baseUrl: props.baseUrl,
  }));

  const isFiltered = () => !!props.platform;
  const toolkitId = () => (props.platform ? PLATFORM_TO_TOOLKIT[props.platform] : undefined);

  return (
    <div>
      <h3 class="setup-step__heading">
        {props.platform === 'hermes'
          ? 'Connect your Hermes harness to Manifest'
          : props.platform === 'openclaw'
            ? 'Connect your OpenClaw harness to Manifest'
            : props.platform === 'nanobot'
              ? 'Connect your Nanobot harness to Manifest'
              : props.platform === 'craft'
                ? 'Connect your Craft harness to Manifest'
                : props.platform === 'n8n'
                  ? 'Connect n8n to Manifest'
                  : props.platform === 'claude-code'
                    ? 'Connect Claude Code to Manifest'
                    : props.platform === 'opencode'
                      ? 'Connect OpenCode to Manifest'
                      : props.platform === 'codex'
                        ? 'Connect Codex to Manifest'
                        : 'Connect your harness to Manifest'}
      </h3>

      {/* Platform-filtered mode: show only relevant content */}
      <Show when={isFiltered()}>
        <Switch>
          <Match when={props.platform === 'openclaw'}>
            <OpenClawSetup {...snippetProps()} />
          </Match>
          <Match when={props.platform === 'hermes'}>
            <HermesSetup {...snippetProps()} />
          </Match>
          <Match when={props.platform === 'nanobot'}>
            <NanobotSetup {...snippetProps()} />
          </Match>
          <Match when={props.platform === 'craft'}>
            <CraftAgentSetup {...snippetProps()} />
          </Match>
          <Match when={props.platform === 'n8n'}>
            <N8nSetup {...snippetProps()} />
          </Match>
          <Match when={props.platform === 'claude-code'}>
            <ClaudeCodeSetup {...snippetProps()} />
          </Match>
          <Match when={props.platform === 'opencode'}>
            <OpenCodeSetup {...snippetProps()} />
          </Match>
          <Match when={props.platform === 'codex'}>
            <CodexSetup {...snippetProps()} />
          </Match>
          <Match when={toolkitId()}>
            <FrameworkSnippets
              {...snippetProps()}
              hideFullKey={props.hideFullKey}
              defaultToolkit={toolkitId()!}
            />
          </Match>
          <Match when={props.platform === 'other'}>
            <FrameworkSnippets
              {...snippetProps()}
              hideFullKey={props.hideFullKey}
              defaultToolkit="curl"
            />
          </Match>
        </Switch>
      </Show>

      {/* Default / "other": show full tabbed UI */}
      <Show when={!isFiltered()}>
        <p class="setup-step__desc">
          Point your harness at the Manifest endpoint using the model{' '}
          <code class="setup-model-hint__code">auto</code>
        </p>

        <div class="setup-segment" role="tablist" aria-label="Setup method">
          <button
            class="setup-segment__btn"
            classList={{ 'setup-segment__btn--active': activeTab() === 'agents' }}
            onClick={() => setActiveTab('agents')}
            role="tab"
            aria-selected={activeTab() === 'agents'}
          >
            Agents
          </button>
          <button
            class="setup-segment__btn"
            classList={{ 'setup-segment__btn--active': activeTab() === 'toolkits' }}
            onClick={() => setActiveTab('toolkits')}
            role="tab"
            aria-selected={activeTab() === 'toolkits'}
          >
            Toolkits
          </button>
        </div>

        <Show when={activeTab() === 'toolkits'}>
          <FrameworkSnippets {...snippetProps()} hideFullKey={props.hideFullKey} />
        </Show>

        <Show when={activeTab() === 'agents'}>
          <div class="setup-method-tabs">
            <div class="panel__tabs" role="tablist" aria-label="Agent framework">
              <button
                class="panel__tab"
                classList={{ 'panel__tab--active': activeAgent() === 'openclaw' }}
                onClick={() => setActiveAgent('openclaw')}
                role="tab"
                aria-selected={activeAgent() === 'openclaw'}
              >
                <img
                  src="/icons/openclaw.svg"
                  alt=""
                  class="panel__tab-icon"
                  width="16"
                  height="16"
                />
                OpenClaw
              </button>
              <button
                class="panel__tab"
                classList={{ 'panel__tab--active': activeAgent() === 'hermes' }}
                onClick={() => setActiveAgent('hermes')}
                role="tab"
                aria-selected={activeAgent() === 'hermes'}
              >
                <img
                  src="/icons/hermes.svg"
                  alt=""
                  class="platform-icon panel__tab-icon"
                  width="16"
                  height="16"
                />
                Hermes Agent
              </button>
              <button
                class="panel__tab"
                classList={{ 'panel__tab--active': activeAgent() === 'nanobot' }}
                onClick={() => setActiveAgent('nanobot')}
                role="tab"
                aria-selected={activeAgent() === 'nanobot'}
              >
                <img
                  src="/icons/nanobot.png"
                  alt=""
                  class="panel__tab-icon"
                  width="16"
                  height="16"
                />
                Nanobot
              </button>
              <button
                class="panel__tab"
                classList={{ 'panel__tab--active': activeAgent() === 'craft' }}
                onClick={() => setActiveAgent('craft')}
                role="tab"
                aria-selected={activeAgent() === 'craft'}
              >
                <img src="/icons/craft.png" alt="" class="panel__tab-icon" width="16" height="16" />
                Craft Agent
              </button>
              <button
                class="panel__tab"
                classList={{ 'panel__tab--active': activeAgent() === 'claude-code' }}
                onClick={() => setActiveAgent('claude-code')}
                role="tab"
                aria-selected={activeAgent() === 'claude-code'}
              >
                <img
                  src="/icons/providers/claude-code.svg"
                  alt=""
                  class="panel__tab-icon"
                  width="16"
                  height="16"
                />
                Claude Code
              </button>
              <button
                class="panel__tab"
                classList={{ 'panel__tab--active': activeAgent() === 'opencode' }}
                onClick={() => setActiveAgent('opencode')}
                role="tab"
                aria-selected={activeAgent() === 'opencode'}
              >
                <img
                  src="/icons/providers/opencode.svg"
                  alt=""
                  class="panel__tab-icon"
                  width="16"
                  height="16"
                />
                OpenCode
              </button>
              <button
                class="panel__tab"
                classList={{ 'panel__tab--active': activeAgent() === 'codex' }}
                onClick={() => setActiveAgent('codex')}
                role="tab"
                aria-selected={activeAgent() === 'codex'}
              >
                <img
                  src="/icons/providers/codex.svg"
                  alt=""
                  class="panel__tab-icon"
                  width="16"
                  height="16"
                />
                Codex
              </button>
            </div>
          </div>

          <Switch>
            <Match when={activeAgent() === 'openclaw'}>
              <OpenClawSetup {...snippetProps()} />
            </Match>
            <Match when={activeAgent() === 'hermes'}>
              <HermesSetup {...snippetProps()} />
            </Match>
            <Match when={activeAgent() === 'nanobot'}>
              <NanobotSetup {...snippetProps()} />
            </Match>
            <Match when={activeAgent() === 'craft'}>
              <CraftAgentSetup {...snippetProps()} />
            </Match>
            <Match when={activeAgent() === 'claude-code'}>
              <ClaudeCodeSetup {...snippetProps()} />
            </Match>
            <Match when={activeAgent() === 'opencode'}>
              <OpenCodeSetup {...snippetProps()} />
            </Match>
            <Match when={activeAgent() === 'codex'}>
              <CodexSetup {...snippetProps()} />
            </Match>
          </Switch>
        </Show>
      </Show>
    </div>
  );
};

export default SetupStepAddProvider;
