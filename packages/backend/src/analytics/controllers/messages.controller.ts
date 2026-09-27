import {
  Controller,
  Get,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { MessagesQueryDto, type MessageTriggerFilter } from '../dto/messages-query.dto';
import { MessageFeedbackDto } from '../dto/message-feedback.dto';
import { MessagesQueryService } from '../services/messages-query.service';
import { MessageDetailsService } from '../services/message-details.service';
import { MessageFeedbackService } from '../services/message-feedback.service';
import { SpecificityFeedbackService } from '../services/specificity-feedback.service';
import { TenantCtx, TenantContext } from '../../common/decorators/tenant-context.decorator';

/** Comma-separated query value → a bounded list of trimmed, non-empty entries. */
function splitCsv(value: string | undefined, max = 50): string[] | undefined {
  if (!value) return undefined;
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, max);
}

@Controller('api/v1')
export class MessagesController {
  constructor(
    private readonly messagesQuery: MessagesQueryService,
    private readonly messageDetails: MessageDetailsService,
    private readonly messageFeedback: MessageFeedbackService,
    private readonly specificityFeedback: SpecificityFeedbackService,
  ) {}

  @Get('messages')
  async getMessages(@Query() query: MessagesQueryDto, @TenantCtx() ctx: TenantContext) {
    return this.messagesQuery.getMessages({
      range: query.range,
      tenantId: ctx.tenantId,
      provider: query.provider,
      connections: splitCsv(query.connections),
      models: splitCsv(query.model),
      service_type: query.service_type,
      cost_min: query.cost_min,
      cost_max: query.cost_max,
      limit: Math.min(query.limit ?? 50, 200),
      cursor: query.cursor,
      agent_name: query.agent_name,
      status: query.status,
      attemptStatus: query.attempts
        ? ([...new Set(query.attempts.split(','))] as ('has_failed' | 'has_succeeded')[])
        : undefined,
      triggers: query.trigger
        ? ([...new Set(query.trigger.split(','))] as MessageTriggerFilter[])
        : undefined,
      origin: query.origin,
      error_class: query.error_class,
      routing_tier: query.routing_tier,
      specificity_category: query.specificity_category,
      header_tier_id: query.header_tier_id,
      include_total: query.include_total,
      cache_total: query.cache_total,
      include_filter_options: query.include_filter_options,
    });
  }

  @Get('messages/filter-options')
  async getMessageFilterOptions(@Query() query: MessagesQueryDto, @TenantCtx() ctx: TenantContext) {
    return this.messagesQuery.getMessageFilterOptions({
      range: query.range,
      tenantId: ctx.tenantId,
      agent_name: query.agent_name,
    });
  }

  @Get('messages/:id/details')
  async getMessageDetails(@Param('id') id: string, @TenantCtx() ctx: TenantContext) {
    return this.messageDetails.getDetails(id, ctx.tenantId);
  }

  @Patch('messages/:id/feedback')
  @HttpCode(HttpStatus.NO_CONTENT)
  async setFeedback(
    @Param('id') id: string,
    @Body() body: MessageFeedbackDto,
    @TenantCtx() ctx: TenantContext,
  ) {
    await this.messageFeedback.setFeedback(id, ctx.tenantId, body.rating, body.tags, body.details);
  }

  @Delete('messages/:id/feedback')
  @HttpCode(HttpStatus.NO_CONTENT)
  async clearFeedback(@Param('id') id: string, @TenantCtx() ctx: TenantContext) {
    await this.messageFeedback.clearFeedback(id, ctx.tenantId);
  }

  @Patch('messages/:id/miscategorized')
  @HttpCode(HttpStatus.NO_CONTENT)
  async flagMiscategorized(@Param('id') id: string, @TenantCtx() ctx: TenantContext) {
    await this.specificityFeedback.flagMiscategorized(id, ctx.tenantId);
  }

  @Delete('messages/:id/miscategorized')
  @HttpCode(HttpStatus.NO_CONTENT)
  async clearMiscategorized(@Param('id') id: string, @TenantCtx() ctx: TenantContext) {
    await this.specificityFeedback.clearFlag(id, ctx.tenantId);
  }
}
