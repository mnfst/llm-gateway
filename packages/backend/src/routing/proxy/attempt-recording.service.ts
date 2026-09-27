import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AgentMessage } from '../../entities/agent-message.entity';
import type { StoredAttemptRecording } from './attempt-recording.types';
import { RequestRecordingStorageService } from '../../common/services/request-recording-storage.service';
import { encodeRequestRecording } from '../../common/utils/request-recording-codec';

@Injectable()
export class AttemptRecordingService {
  constructor(
    @InjectRepository(AgentMessage)
    private readonly attemptRepo: Repository<AgentMessage>,
    private readonly storage: RequestRecordingStorageService,
  ) {}

  get available(): boolean {
    return this.storage.backend !== null;
  }

  async save(
    tenantId: string,
    requestId: string,
    attemptId: string,
    payload: StoredAttemptRecording,
  ): Promise<void> {
    const storageKey = this.storage.objectKey(tenantId, requestId, attemptId);
    let uploaded = false;
    try {
      const encoded = await encodeRequestRecording(payload);
      await this.storage.put(storageKey, encoded);
      uploaded = true;
      const result = await this.attemptRepo.update(
        { id: attemptId, tenant_id: tenantId, request_id: requestId },
        { recording_key: storageKey },
      );
      if (result.affected === 0) {
        throw new Error(`Provider Attempt ${attemptId} no longer exists`);
      }
    } catch (error) {
      if (uploaded) await this.storage.delete(storageKey).catch(() => undefined);
      throw error;
    }
  }
}
