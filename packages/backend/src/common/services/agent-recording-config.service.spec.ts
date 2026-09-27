import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Agent } from '../../entities/agent.entity';
import { AgentRecordingConfigService } from './agent-recording-config.service';

describe('AgentRecordingConfigService', () => {
  const findOne = jest.fn();
  let service: AgentRecordingConfigService;

  beforeEach(async () => {
    findOne.mockReset();
    const module = await Test.createTestingModule({
      providers: [
        AgentRecordingConfigService,
        { provide: getRepositoryToken(Agent), useValue: { findOne } },
      ],
    }).compile();
    service = module.get(AgentRecordingConfigService);
  });

  it('does not query for a missing agent id', async () => {
    await expect(service.isRecording(undefined)).resolves.toBe(false);
    expect(findOne).not.toHaveBeenCalled();
  });

  it('reads the current flag on every request across replicas', async () => {
    findOne
      .mockResolvedValueOnce({ id: 'agent-1', record_messages: true })
      .mockResolvedValueOnce({ id: 'agent-1', record_messages: false });

    await expect(service.isRecording('agent-1')).resolves.toBe(true);
    await expect(service.isRecording('agent-1')).resolves.toBe(false);
    expect(findOne).toHaveBeenCalledTimes(2);
  });
});
