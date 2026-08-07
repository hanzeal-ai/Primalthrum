import { type Awaitable } from './storeTypes';
import { type PublicUserRecord } from './userRepository';
import {
  type CreatedWorkspaceInvitation,
  type WorkspaceInvitationRecord,
  type WorkspaceMembershipRecord,
  type WorkspaceRecord,
  type WorkspaceRole,
} from './workspaceRepository';

export interface WorkspaceStore {
  create(ownerUserId: number, name: unknown): Awaitable<WorkspaceRecord>;
  findById(id: number): Awaitable<WorkspaceRecord | null>;
  findBySlug(slug: string): Awaitable<WorkspaceRecord | null>;
  listForUser(userId: number): Awaitable<Array<WorkspaceRecord & { role: WorkspaceRole }>>;
  findMembership(
    workspaceId: number,
    userId: number,
  ): Awaitable<WorkspaceMembershipRecord | null>;
  listMembers(workspaceId: number): Awaitable<WorkspaceMembershipRecord[]>;
  pendingInvitationCount(workspaceId: number, excludeEmail?: string): Awaitable<number>;
  validateInvitationTarget(workspaceId: number, value: unknown): Awaitable<string>;
  principalForUser(userId: number, workspaceId?: number): Awaitable<PublicUserRecord | null>;
  createInvitation(input: {
    workspaceId: number;
    email: unknown;
    role: unknown;
    invitedByUserId: number;
  }): Awaitable<CreatedWorkspaceInvitation>;
  listInvitations(workspaceId: number): Awaitable<WorkspaceInvitationRecord[]>;
  revokeInvitation(workspaceId: number, invitationId: number): Awaitable<void>;
  acceptInvitation(
    token: string,
    userId: number,
    userEmail: string,
  ): Awaitable<WorkspaceMembershipRecord>;
  acceptInvitationById(
    workspaceId: number,
    invitationId: number,
    userId: number,
    userEmail: string,
  ): Awaitable<WorkspaceMembershipRecord>;
  activeInvitationByToken(token: string): Awaitable<WorkspaceInvitationRecord | null>;
  updateMemberRole(
    workspaceId: number,
    userId: number,
    role: unknown,
  ): Awaitable<WorkspaceMembershipRecord>;
  removeMember(workspaceId: number, userId: number): Awaitable<void>;
}
