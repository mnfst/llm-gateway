import type { IncomingHttpHeaders } from 'http';
import type { RecordingResponseBody } from './attempt-recording.types';
import { ProviderEndpoint } from './provider-endpoints';
import type { AttemptRecordingCapture } from './attempt-recording-capture';
import type { ThinkingBlock, ThinkingBlockRouteContext } from './thinking-block-cache';
import { CallerAttribution } from './caller-classifier';

/**
 * Optional lookup to re-inject cached thought_signature values that were
 * stripped by the client. Called with a tool_call id; returns the cached
 * signature or null.
 */
export type SignatureLookup = (toolCallId: string) => string | null;

/**
 * Optional lookup to re-inject cached Anthropic thinking blocks that were
 * stripped by the client. Called with the first tool_use id from the
 * assistant turn; returns the ordered block sequence or null.
 */
export type ThinkingBlockLookup = (
  firstToolUseId: string,
  routeContext?: ThinkingBlockRouteContext,
) => ThinkingBlock[] | null;

export type ProxyApiMode = 'chat_completions' | 'responses' | 'messages';

/** Lazily derive the Chat Completions view used by legacy routing or cross-protocol adapters. */
export type ResolveChatBody = () => Promise<Record<string, unknown>>;

/** The protocol shape actually emitted at the provider transport boundary. */
export type ProviderWireFormat =
  | 'openai_chat_completions'
  | 'openai_responses'
  | 'anthropic_messages'
  | 'google_generate_content'
  | 'google_code_assist'
  | 'kiro_chat';

export interface ProviderAttemptRecordingStart {
  requestBody: Record<string, unknown>;
  wireFormat: ProviderWireFormat;
}

export interface ProviderAttemptStart {
  provider: string;
  model: string;
  authType?: string;
  tenantProviderId?: string | null;
  /** Reserve ordering for a Manifest-local route failure without a pending provider-call row. */
  providerCallStarted?: boolean;
  /**
   * Label of the connection serving this attempt. Carried from the start so a
   * row that never reaches a terminal writer (a cancelled request) still names
   * the connection it was billed against.
   */
  keyLabel?: string;
}

/** Identity and measured start of one Attempt. */
export interface ProviderAttemptRef {
  id: string;
  attemptNumber: number;
  startedAtMs: number;
  startedAt: string;
  completedAtMs?: number;
  pendingWrite: Promise<boolean>;
  completeFailure?: (failure: {
    status: number;
    errorBody: string;
    superseded: boolean;
  }) => Promise<void>;
  /** Capture owned by this exact provider call, never by the parent Request. */
  recordingCapture?: AttemptRecordingCapture;
  startRecording?: (recording: ProviderAttemptRecordingStart) => void;
  finishRecording?: (response?: RecordingResponseBody | null) => Promise<void>;
}

export type StartProviderAttempt = (attempt: ProviderAttemptStart) => ProviderAttemptRef;

export interface OpenAIMessage {
  role: string;
  content?: unknown;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  [key: string]: unknown;
}

/** Options for forwarding a request to a provider via ProviderClient. */
export interface ForwardOptions {
  provider: string;
  apiKey: string;
  model: string;
  body: Record<string, unknown>;
  resolveChatBody?: ResolveChatBody;
  apiMode?: ProxyApiMode;
  /** Legacy caller session identifier. Provider cache affinity must use providerCacheKey. */
  sessionKey?: string;
  /** Opaque, tenant/agent/session-scoped provider prompt-cache affinity key. */
  providerCacheKey?: string;
  stream: boolean;
  signal?: AbortSignal;
  extraHeaders?: Record<string, string>;
  customEndpoint?: ProviderEndpoint;
  authType?: string;
  /** Lookup for re-injecting cached thought_signature values (Google only). */
  signatureLookup?: SignatureLookup;
  /** Lookup for re-injecting cached thinking blocks (Anthropic only). */
  thinkingLookup?: ThinkingBlockLookup;
  /** Route scope used to decide whether cached Anthropic thinking can be replayed. */
  thinkingRouteContext?: ThinkingBlockRouteContext;
  /**
   * The caller's raw `anthropic-beta` header, merged into (never replacing)
   * Manifest's own flags when the resolved endpoint is Anthropic itself (the
   * `anthropic` route or a custom row pointed at it, never the
   * Anthropic-compatible third parties). Without it, beta-gated
   * body fields the caller legitimately sent come back as
   * `<field>: Extra inputs are not permitted`. Sanitized at the merge.
   */
  clientAnthropicBeta?: string | string[];
  /**
   * Provider-specific routing field carried in the OAuth token blob's `u`
   * slot. For Gemini OAuth this is the CodeAssist
   * `cloudaicompanionProject` id assigned during `enrichBlob`.
   */
  providerResource?: string;
  /** Persisted identity of this exact upstream call. */
  attempt?: ProviderAttemptRef;
}

/** Options for ProxyService.proxyRequest. */
export interface ProxyRequestOptions {
  agentId: string;
  /** Tenant that owns the agent — the scoping key for every provider/key/limit lookup. */
  tenantId: string;
  /**
   * Owning user, when one exists. Informational attribution for the message
   * recorder (`agent_messages.user_id`) only — never used for scoping,
   * keying, or rate limiting.
   */
  userId: string | null;
  body: Record<string, unknown>;
  /** Body used for Manifest-owned routing/scoring/recording; large inline media may be redacted. */
  routingBody?: Record<string, unknown>;
  apiMode?: ProxyApiMode;
  sessionKey: string;
  /** Fixed-length tenant/agent/session key for internal replay caches. */
  sessionCacheKey: string;
  /** Scoped provider prompt-cache key; absent when the caller omitted x-session-key. */
  providerCacheKey?: string;
  /** Scoped routing-momentum key; absent when the caller omitted x-session-key. */
  sessionMomentumKey?: string;
  agentName?: string;
  signal?: AbortSignal;
  specificityOverride?: string;
  callerAttribution?: CallerAttribution | null;
  headers?: IncomingHttpHeaders;
  /** Allocates the next Attempt; local route failures set providerCallStarted=false. */
  startProviderAttempt?: StartProviderAttempt;
}
