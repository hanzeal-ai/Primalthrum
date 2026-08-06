import { type DocumentFileStorage } from './fileStorage';
import {
  RetentionPolicyRepository,
  type RetentionEventRecord,
} from './retentionPolicyRepository';

export interface RetentionEnforcementOutcome {
  event: RetentionEventRecord;
  filesDeleted: number;
  fileDeletionFailures: number;
  blockedByLegalHold: boolean;
}

export class RetentionService {
  constructor(
    private readonly policies: RetentionPolicyRepository,
    private readonly storage: DocumentFileStorage,
  ) {}

  async enforce(
    workspaceId: number,
    actorUserId: number | null,
  ): Promise<RetentionEnforcementOutcome> {
    const event = this.policies.enforce(workspaceId, actorUserId);
    const blockedByLegalHold = event.eventType === 'enforcement_blocked';
    const files = blockedByLegalHold
      ? { deleted: 0, failed: 0 }
      : await this.drainFileDeletions(workspaceId);
    return {
      event,
      filesDeleted: files.deleted,
      fileDeletionFailures: files.failed,
      blockedByLegalHold,
    };
  }

  async drainFileDeletions(
    workspaceId: number,
  ): Promise<{ deleted: number; failed: number }> {
    let deleted = 0;
    let failed = 0;
    for (const deletion of this.policies.pendingFileDeletions(workspaceId)) {
      try {
        await this.storage.delete(deletion.storageRef);
        this.policies.completeFileDeletion(deletion.id);
        deleted += 1;
      } catch (error) {
        this.policies.failFileDeletion(
          deletion.id,
          deletion.attempts,
          error instanceof Error ? error.message : 'document deletion failed',
        );
        failed += 1;
      }
    }
    return { deleted, failed };
  }
}
