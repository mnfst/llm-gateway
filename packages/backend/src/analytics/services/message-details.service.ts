import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AgentMessage } from '../../entities/agent-message.entity';
import type { CallerAttribution } from '../../routing/proxy/caller-classifier';
import type { PhoenixExplanation, PhoenixOperation } from '../../routing/autofix/phoenix.types';
import { isSuccessStatus, type AutofixStatus, type RequestParamDefaults } from 'manifest-shared';
import { ManifestRequest } from '../../entities/request.entity';
import type { RecordingResponseBody } from '../../routing/proxy/attempt-recording.types';
import { RequestRecordingStorageService } from '../../common/services/request-recording-storage.service';
import { decodeRequestRecording } from '../../common/utils/request-recording-codec';

export interface MessageDetailResponse {
  message: {
    id: string;
    timestamp: string;
    agent_name: string | null;
    model: string | null;
    status: string;
    autofix_status: AutofixStatus | null;
    error_message: string | null;
    error_code: string | null;
    error_http_status: number | null;
    error_origin: string | null;
    error_class: string | null;
    superseded: boolean;
    description: string | null;
    service_type: string | null;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    cost_usd: number | null;
    duration_ms: number | null;
    trace_id: string | null;
    routing_tier: string | null;
    routing_reason: string | null;
    specificity_category: string | null;
    specificity_miscategorized: boolean;
    auth_type: string | null;
    provider_key_label: string | null;
    skill_name: string | null;
    fallback_from_model: string | null;
    fallback_index: number | null;
    session_key: string | null;
    feedback_rating: string | null;
    feedback_tags: string[] | null;
    feedback_details: string | null;
    request_headers: Record<string, string> | null;
    request_params: RequestParamDefaults | null;
    caller_attribution: CallerAttribution | null;
    header_tier_id: string | null;
    header_tier_name: string | null;
    header_tier_color: string | null;
    autofix_applied: boolean;
    autofix_role: string | null;
    autofix_operations: PhoenixOperation[] | null;
    /** Phoenix's decision behind this provider attempt. */
    autofix_decision: {
      status: string | null;
      issueId: string | null;
      patchId: string | null;
      healAttemptId: string | null;
      explanation?: PhoenixExplanation | null;
    } | null;
    /** The paired row (failed original ↔ successful retry), for the visual link. */
    autofix_sibling: { id: string; role: string | null; status: string } | null;
    attempts?: Array<{
      id: string;
      model: string | null;
      provider: string | null;
      status: string;
      auth_type: string | null;
      error_message: string | null;
      error_origin: string | null;
      error_class: string | null;
      error_http_status: number | null;
      duration_ms: number | null;
      cost_usd: number | null;
      input_tokens: number;
      output_tokens: number;
      fallback_from_model: string | null;
      fallback_index: number | null;
      request_headers: Record<string, string> | null;
      request_params: object | null;
      autofix_applied: boolean;
      autofix_role: string | null;
      autofix_operations: object | null;
      autofix_decision: object | null;
      recording: AttemptRecordingDetail | null;
    }>;
  };
}

export interface AttemptRecordingDetail {
  request_body: Record<string, unknown>;
  response_body: RecordingResponseBody | null;
  wire_format: string;
}

@Injectable()
export class MessageDetailsService {
  private readonly logger = new Logger(MessageDetailsService.name);

  constructor(
    @InjectRepository(AgentMessage)
    private readonly messageRepo: Repository<AgentMessage>,
    @Optional()
    @InjectRepository(ManifestRequest)
    private readonly requestRepo?: Repository<ManifestRequest>,
    @Optional()
    private readonly recordingStorage?: RequestRecordingStorageService,
  ) {}

  async getDetails(messageId: string, tenantId: string | null): Promise<MessageDetailResponse> {
    // No tenant → no messages, so any id is unknown.
    if (!tenantId) throw new NotFoundException('Message not found');

    let request = this.requestRepo
      ? await this.requestRepo.findOne({ where: { id: messageId, tenant_id: tenantId } })
      : null;
    let attempts = request
      ? await this.messageRepo.find({
          where: { request_id: request.id, tenant_id: tenantId },
          order: { timestamp: 'ASC' },
        })
      : [];
    let message = request
      ? ([...attempts].reverse().find((attempt) => isSuccessStatus(attempt.status)) ??
        attempts[attempts.length - 1] ??
        null)
      : await this.messageRepo
          .createQueryBuilder('m')
          .where('m.id = :id', { id: messageId })
          .andWhere('m.tenant_id = :tenantId', { tenantId })
          .getOne();

    // A Messages row fetched before the online backfill may still link to its
    // old synthetic attempt id. If the user opens it after that row has been
    // grouped, follow request_id and render the complete request instead of a
    // misleading one-attempt detail.
    if (!request && message?.request_id && this.requestRepo) {
      request = await this.requestRepo.findOne({
        where: { id: message.request_id, tenant_id: tenantId },
      });
      if (request) {
        attempts = await this.messageRepo.find({
          where: { request_id: request.id, tenant_id: tenantId },
          order: { timestamp: 'ASC' },
        });
        message =
          [...attempts].reverse().find((attempt) => isSuccessStatus(attempt.status)) ??
          attempts[attempts.length - 1] ??
          message;
      }
    }
    if (!message && !request) throw new NotFoundException('Message not found');

    const recordingsByAttempt = await this.loadAttemptRecordings(attempts);

    const autofix_sibling = message?.autofix_group_id
      ? await this.findAutofixSibling(message.id, message.autofix_group_id, tenantId)
      : null;

    const inputTokens = request
      ? attempts.reduce((sum, attempt) => sum + attempt.input_tokens, 0)
      : message!.input_tokens;
    const outputTokens = request
      ? attempts.reduce((sum, attempt) => sum + attempt.output_tokens, 0)
      : message!.output_tokens;
    const cacheReadTokens = request
      ? attempts.reduce((sum, attempt) => sum + attempt.cache_read_tokens, 0)
      : message!.cache_read_tokens;
    const cacheCreationTokens = request
      ? attempts.reduce((sum, attempt) => sum + attempt.cache_creation_tokens, 0)
      : message!.cache_creation_tokens;
    const cost = request
      ? attempts.reduce((sum, attempt) => sum + Number(attempt.cost_usd ?? 0), 0)
      : message!.cost_usd;
    const duration = request
      ? attempts.length > 0
        ? attempts.reduce((sum, attempt) => sum + (attempt.duration_ms ?? 0), 0)
        : request.duration_ms
      : message!.duration_ms;

    const response: MessageDetailResponse = {
      message: {
        id: request?.id ?? message!.id,
        timestamp: request?.timestamp ?? message!.timestamp,
        agent_name: request?.agent_name ?? message?.agent_name ?? null,
        model: message?.model ?? request?.requested_model ?? null,
        status: request?.status ?? message!.status,
        autofix_status: request?.autofix_status ?? null,
        error_message: request?.error_message ?? message?.error_message ?? null,
        error_code: request ? (request.error_code ?? null) : message!.error_code,
        error_http_status: request?.error_http_status ?? message?.error_http_status ?? null,
        error_origin: request?.error_origin ?? message?.error_origin ?? null,
        error_class: request?.error_class ?? message?.error_class ?? null,
        superseded: false,
        description: message?.description ?? null,
        service_type: message?.service_type ?? null,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_tokens: cacheReadTokens,
        cache_creation_tokens: cacheCreationTokens,
        cost_usd: cost,
        duration_ms: duration,
        trace_id: request?.trace_id ?? message?.trace_id ?? null,
        routing_tier: message?.routing_tier ?? null,
        routing_reason: message?.routing_reason ?? null,
        specificity_category: message?.specificity_category ?? null,
        specificity_miscategorized: message?.specificity_miscategorized ?? false,
        auth_type: message?.auth_type ?? null,
        provider_key_label: message?.provider_key_label ?? null,
        skill_name: message?.skill_name ?? null,
        fallback_from_model: message?.fallback_from_model ?? null,
        fallback_index: message?.fallback_index ?? null,
        session_key: request?.session_key ?? message?.session_key ?? null,
        feedback_rating: request?.feedback_rating ?? message?.feedback_rating ?? null,
        feedback_tags: (request?.feedback_tags ?? message?.feedback_tags)?.split(',') ?? null,
        feedback_details: request?.feedback_details ?? message?.feedback_details ?? null,
        request_headers: request?.request_headers ?? message?.request_headers ?? null,
        request_params: (request?.request_params ??
          message?.request_params) as RequestParamDefaults | null,
        caller_attribution: request?.caller_attribution ?? message?.caller_attribution ?? null,
        header_tier_id: message?.header_tier_id ?? null,
        header_tier_name: message?.header_tier_name ?? null,
        header_tier_color: message?.header_tier_color ?? null,
        autofix_applied:
          attempts.some((attempt) => attempt.autofix_applied) ||
          (message?.autofix_applied ?? false),
        autofix_role: message?.autofix_role ?? null,
        autofix_operations: (message?.autofix_operations as PhoenixOperation[] | null) ?? null,
        autofix_decision:
          (message?.autofix_decision as {
            status: string | null;
            issueId: string | null;
            patchId: string | null;
            healAttemptId: string | null;
            explanation?: PhoenixExplanation | null;
          } | null) ?? null,
        autofix_sibling,
        ...(request
          ? {
              // The drawer renders each attempt's full story (details, error
              // card, fallback/autofix context cards, headers/params tabs) —
              // project the whole per-attempt surface, not just the summary.
              attempts: attempts.map((attempt) => ({
                id: attempt.id,
                model: attempt.model,
                provider: attempt.provider,
                status: attempt.status,
                auth_type: attempt.auth_type,
                error_message: attempt.error_message,
                error_origin: attempt.error_origin,
                error_class: attempt.error_class,
                error_http_status: attempt.error_http_status,
                duration_ms: attempt.duration_ms,
                cost_usd: attempt.cost_usd,
                input_tokens: attempt.input_tokens,
                output_tokens: attempt.output_tokens,
                fallback_from_model: attempt.fallback_from_model,
                fallback_index: attempt.fallback_index,
                request_headers: attempt.request_headers,
                request_params: attempt.request_params,
                autofix_applied: attempt.autofix_applied,
                autofix_role: attempt.autofix_role,
                autofix_operations: attempt.autofix_operations,
                autofix_decision: attempt.autofix_decision,
                recording: recordingsByAttempt.get(attempt.id) ?? null,
              })),
            }
          : {}),
      },
    };
    return response;
  }

  private async loadAttemptRecordings(
    attempts: AgentMessage[],
  ): Promise<Map<string, AttemptRecordingDetail>> {
    const result = new Map<string, AttemptRecordingDetail>();
    if (!this.recordingStorage || attempts.length === 0) return result;

    await Promise.all(
      attempts.map(async (attempt) => {
        if (!attempt.recording_key) return;
        const payload = await this.loadRecording(attempt.id, attempt.recording_key);
        if (!payload) return;
        result.set(attempt.id, {
          request_body: payload.request_body,
          response_body: payload.response_body,
          wire_format: payload.wire_format,
        });
      }),
    );
    return result;
  }

  private async loadRecording(attemptId: string, storageKey: string) {
    if (!this.recordingStorage) return null;
    try {
      return await decodeRequestRecording(await this.recordingStorage.get(storageKey));
    } catch (error) {
      this.logger.warn(
        `Failed to load Provider Attempt recording ${attemptId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  /** Resolve the paired Autofix row (failed original ↔ successful retry). */
  private async findAutofixSibling(
    id: string,
    groupId: string,
    tenantId: string,
  ): Promise<{ id: string; role: string | null; status: string } | null> {
    const sibling = await this.messageRepo
      .createQueryBuilder('m')
      .where('m.autofix_group_id = :groupId', { groupId })
      .andWhere('m.tenant_id = :tenantId', { tenantId })
      .andWhere('m.id != :id', { id })
      .orderBy('m.timestamp', 'DESC')
      .getOne();
    if (!sibling) return null;
    return { id: sibling.id, role: sibling.autofix_role, status: sibling.status };
  }
}
