import { Test, TestingModule } from '@nestjs/testing';
import { MessagesController } from './messages.controller';
import { MessagesQueryService } from '../services/messages-query.service';
import { MessageDetailsService } from '../services/message-details.service';
import { MessageFeedbackService } from '../services/message-feedback.service';
import { SpecificityFeedbackService } from '../services/specificity-feedback.service';

describe('MessagesController', () => {
  let controller: MessagesController;
  let mockGetMessages: jest.Mock;
  let mockGetMessageFilterOptions: jest.Mock;
  let mockGetDetails: jest.Mock;
  let mockSetFeedback: jest.Mock;
  let mockClearFeedback: jest.Mock;
  let mockFlagMiscategorized: jest.Mock;
  let mockClearMiscategorized: jest.Mock;

  beforeEach(async () => {
    mockGetMessages = jest.fn().mockResolvedValue({
      items: [],
      next_cursor: null,
      total_count: 0,
      providers: [],
    });
    mockGetMessageFilterOptions = jest.fn().mockResolvedValue({ providers: [] });

    mockGetDetails = jest.fn().mockResolvedValue({
      message: { id: 'msg-1', status: 'ok' },
    });

    mockSetFeedback = jest.fn().mockResolvedValue(undefined);
    mockClearFeedback = jest.fn().mockResolvedValue(undefined);
    mockFlagMiscategorized = jest.fn().mockResolvedValue(undefined);
    mockClearMiscategorized = jest.fn().mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      controllers: [MessagesController],
      providers: [
        {
          provide: MessagesQueryService,
          useValue: {
            getMessages: mockGetMessages,
            getMessageFilterOptions: mockGetMessageFilterOptions,
          },
        },
        {
          provide: MessageDetailsService,
          useValue: { getDetails: mockGetDetails },
        },
        {
          provide: MessageFeedbackService,
          useValue: { setFeedback: mockSetFeedback, clearFeedback: mockClearFeedback },
        },
        {
          provide: SpecificityFeedbackService,
          useValue: {
            flagMiscategorized: mockFlagMiscategorized,
            clearFlag: mockClearMiscategorized,
          },
        },
      ],
    }).compile();

    controller = module.get<MessagesController>(MessagesController);
  });

  const ctx = { tenantId: 'tenant-1', userId: 'u1' };

  it('delegates to messages query service with default values', async () => {
    await controller.getMessages({} as never, ctx as never);

    expect(mockGetMessages).toHaveBeenCalledWith({
      range: undefined,
      tenantId: 'tenant-1',
      provider: undefined,
      service_type: undefined,
      cost_min: undefined,
      cost_max: undefined,
      limit: 50,
      cursor: undefined,
      agent_name: undefined,
      status: undefined,
      connections: undefined,
      attemptStatus: undefined,
      triggers: undefined,
      routing_tier: undefined,
      specificity_category: undefined,
      header_tier_id: undefined,
      include_total: undefined,
      cache_total: undefined,
      include_filter_options: undefined,
    });
  });

  it('splits the model filter into a trimmed list, dropping empty entries', async () => {
    await controller.getMessages({ model: 'gpt-4o, , claude-3.5-sonnet ' } as never, ctx as never);

    expect(mockGetMessages).toHaveBeenCalledWith(
      expect.objectContaining({ models: ['gpt-4o', 'claude-3.5-sonnet'] }),
    );
  });

  it('caps the model filter so a long query string cannot widen the IN clause', async () => {
    const many = Array.from({ length: 60 }, (_, i) => `model-${i}`).join(',');
    await controller.getMessages({ model: many } as never, ctx as never);

    const sent = mockGetMessages.mock.calls.at(-1)?.[0] as { models: string[] };
    expect(sent.models).toHaveLength(50);
    expect(sent.models.at(-1)).toBe('model-49');
  });

  it('passes all filter parameters', async () => {
    const query = {
      range: '7d',
      provider: 'openai',
      service_type: 'agent',
      cost_min: 0.01,
      cost_max: 10.0,
      limit: 25,
      cursor: 'ts|id',
      agent_name: 'bot-1',
      status: 'failed',
      trigger: 'fallback',
      routing_tier: 'simple',
      specificity_category: 'coding',
      header_tier_id: 'ht-premium',
      include_total: false,
      cache_total: true,
      include_filter_options: false,
    };
    await controller.getMessages(query as never, ctx as never);

    expect(mockGetMessages).toHaveBeenCalledWith({
      range: '7d',
      tenantId: 'tenant-1',
      provider: 'openai',
      service_type: 'agent',
      cost_min: 0.01,
      cost_max: 10.0,
      limit: 25,
      cursor: 'ts|id',
      agent_name: 'bot-1',
      status: 'failed',
      connections: undefined,
      attemptStatus: undefined,
      triggers: ['fallback'],
      routing_tier: 'simple',
      specificity_category: 'coding',
      header_tier_id: 'ht-premium',
      include_total: false,
      cache_total: true,
      include_filter_options: false,
    });
  });

  it('delegates message filter options lookup', async () => {
    await controller.getMessageFilterOptions(
      { range: '30d', agent_name: 'bot-1' } as never,
      ctx as never,
    );

    expect(mockGetMessageFilterOptions).toHaveBeenCalledWith({
      range: '30d',
      tenantId: 'tenant-1',
      agent_name: 'bot-1',
    });
  });

  it('caps limit at 200', async () => {
    await controller.getMessages({ limit: 500 } as never, ctx as never);

    const call = mockGetMessages.mock.calls[0][0];
    expect(call.limit).toBe(200);
  });

  it('returns the service result', async () => {
    const expected = {
      items: [{ id: '1' }],
      next_cursor: 'ts|id',
      total_count: 100,
      providers: ['anthropic', 'openai'],
    };
    mockGetMessages.mockResolvedValue(expected);

    const result = await controller.getMessages({} as never, ctx as never);

    expect(result).toEqual(expected);
  });

  it('delegates getMessageDetails to message details service', async () => {
    await controller.getMessageDetails('msg-123', ctx as never);

    expect(mockGetDetails).toHaveBeenCalledWith('msg-123', 'tenant-1');
  });

  it('returns message details result', async () => {
    const expected = {
      message: { id: 'msg-1', status: 'ok' },
    };
    mockGetDetails.mockResolvedValue(expected);

    const result = await controller.getMessageDetails('msg-1', ctx as never);

    expect(result).toEqual(expected);
  });

  it('delegates setFeedback to feedback service', async () => {
    const body = { rating: 'dislike' as const, tags: ['Slow or buggy'], details: 'test' };
    await controller.setFeedback('msg-1', body, ctx as never);

    expect(mockSetFeedback).toHaveBeenCalledWith(
      'msg-1',
      'tenant-1',
      'dislike',
      ['Slow or buggy'],
      'test',
    );
  });

  it('delegates setFeedback with rating only', async () => {
    const body = { rating: 'like' as const };
    await controller.setFeedback('msg-1', body, ctx as never);

    expect(mockSetFeedback).toHaveBeenCalledWith('msg-1', 'tenant-1', 'like', undefined, undefined);
  });

  it('delegates clearFeedback to feedback service', async () => {
    await controller.clearFeedback('msg-1', ctx as never);

    expect(mockClearFeedback).toHaveBeenCalledWith('msg-1', 'tenant-1');
  });

  it('delegates flagMiscategorized to specificity feedback service', async () => {
    await controller.flagMiscategorized('msg-1', ctx as never);

    expect(mockFlagMiscategorized).toHaveBeenCalledWith('msg-1', 'tenant-1');
  });

  it('delegates clearMiscategorized to specificity feedback service', async () => {
    await controller.clearMiscategorized('msg-1', ctx as never);

    expect(mockClearMiscategorized).toHaveBeenCalledWith('msg-1', 'tenant-1');
  });
});
