import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Agent } from '../../entities/agent.entity';

@Injectable()
export class AgentRecordingConfigService {
  constructor(
    @InjectRepository(Agent)
    private readonly agentRepo: Repository<Agent>,
  ) {}

  async isRecording(agentId: string | null | undefined): Promise<boolean> {
    if (!agentId) return false;
    // This setting controls whether Manifest stores request and response bodies.
    // Read it fresh so a choice changed on one replica applies to all replicas.
    const agent = await this.agentRepo.findOne({
      where: { id: agentId },
      select: ['id', 'record_messages'],
    });
    return agent?.record_messages === true;
  }
}
