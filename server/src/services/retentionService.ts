import { type DocumentFileStorage } from './fileStorage';
import {
  RetentionPolicyRepository,
  type RetentionEventRecord,
} from './retentionPolicyRepository';

export interface RetentionEnforcementOutcome {
  event: RetentionEventRecord;
  filesDeleted: number;
  fileDeletionFailures: number;
}

export class RetentionService {
  constructor(
    private readonly policies: RetentionPolicyRepository,
    private readonly storage: DocumentFileStorage,
  ) {}

  enforce(workspaceId: number, actorUserId: number | null): RetentionEnforcementOutcome {
    const event = this.policies.enforce(workspaceId, actorUserId);
    const files = this.drainFileDeletions(workspaceId);
    return {
      event,
      filesDeleted: files.deleted,
      fileDeletionFailures: files.failed,
    };
  }

  drainFileDeletions(workspaceId: number): { deleted: number; failed: number } {
    let deleted = 0;
    let failed = 0;
    for (const deletion of this.policies.pendingFileDeletions(workspaceId)) {
      try {
        this.storage.delete(deletion.storageRef);
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
