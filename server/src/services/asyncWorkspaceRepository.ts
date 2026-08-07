import { createHash, randomBytes } from 'node:crypto';

import {
  type AsyncDatabaseAdapter,
  type AsyncDatabaseSession,
} from '../db/asyncAdapter';
import {
  databaseTimestamp,
  nullableDatabaseTimestamp,
} from '../db/databaseTimestamp';
import { normalizeEmail, type PublicUserRecord } from './userRepository';
import {
  normalizeWorkspaceRole,
  type CreatedWorkspaceInvitation,
  type WorkspaceInvitationRecord,
  type WorkspaceMembershipRecord,
  type WorkspaceRecord,
  type WorkspaceRole,
} from './workspaceRepository';

const INVITATION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const MAX_SLUG_ATTEMPTS = 100;

interface WorkspaceRow {
  id: number;
  name: string;
  slug: string;
  created_at: string | Date;
  updated_at: string | Date;
}

interface MembershipRow {
  id: number;
  workspace_id: number;
  user_id: number;
  email: string;
  role: WorkspaceRole;
  status: string;
  created_at: string | Date;
  updated_at: string | Date;
}

interface InvitationRow {
  id: number;
  workspace_id: number;
  email: string;
  role: WorkspaceRole;
  expires_at: string | Date;
  accepted_at: string | Date | null;
  revoked_at: string | Date | null;
  created_at: string | Date;
}

interface DatabaseError extends Error {
  code?: string;
  constraint?: string;
}

function workspaceSlugConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const databaseError = error as DatabaseError;
  return (
    databaseError.code === '23505'
    && databaseError.constraint === 'workspaces_slug_key'
  ) || /UNIQUE constraint failed: workspaces\.slug/i.test(error.message);
}

function normalizeWorkspaceName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('workspace name is required');
  return value.trim().slice(0, 100);
}

function slugifyWorkspace(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace';
}

function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function toWorkspace(row: WorkspaceRow): WorkspaceRecord {
  return {
    id: Number(row.id),
    name: row.name,
    slug: row.slug,
    createdAt: databaseTimestamp(row.created_at),
    updatedAt: databaseTimestamp(row.updated_at),
  };
}

function toMembership(row: MembershipRow): WorkspaceMembershipRecord {
  return {
    id: Number(row.id),
    workspaceId: Number(row.workspace_id),
    userId: Number(row.user_id),
    email: row.email,
    role: row.role,
    status: row.status,
    createdAt: databaseTimestamp(row.created_at),
    updatedAt: databaseTimestamp(row.updated_at),
  };
}

function toInvitation(row: InvitationRow): WorkspaceInvitationRecord {
  return {
    id: Number(row.id),
    workspaceId: Number(row.workspace_id),
    email: row.email,
    role: row.role,
    expiresAt: databaseTimestamp(row.expires_at),
    acceptedAt: nullableDatabaseTimestamp(row.accepted_at),
    revokedAt: nullableDatabaseTimestamp(row.revoked_at),
    createdAt: databaseTimestamp(row.created_at),
  };
}

async function findWorkspaceBySlug(
  database: AsyncDatabaseSession,
  slug: string,
): Promise<WorkspaceRecord | null> {
  const rows = await database.query<WorkspaceRow>({
    text: `
      SELECT id, name, slug, created_at, updated_at
      FROM workspaces
      WHERE slug = $1
      LIMIT 1;
    `,
    values: [slug],
  });
  return rows[0] ? toWorkspace(rows[0]) : null;
}

async function findMembership(
  database: AsyncDatabaseSession,
  workspaceId: number,
  userId: number,
): Promise<WorkspaceMembershipRecord | null> {
  const rows = await database.query<MembershipRow>({
    text: `
      SELECT m.id, m.workspace_id, m.user_id, u.email, m.role, m.status,
        m.created_at, m.updated_at
      FROM workspace_memberships m
      JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = $1 AND m.user_id = $2
      LIMIT 1;
    `,
    values: [workspaceId, userId],
  });
  return rows[0] ? toMembership(rows[0]) : null;
}

async function findInvitation(
  database: AsyncDatabaseSession,
  statement: { text: string; values: readonly (string | number)[] },
): Promise<WorkspaceInvitationRecord | null> {
  const rows = await database.query<InvitationRow>(statement);
  return rows[0] ? toInvitation(rows[0]) : null;
}

export class AsyncWorkspaceRepository {
  constructor(private readonly database: AsyncDatabaseAdapter) {}

  async create(ownerUserId: number, name: unknown): Promise<WorkspaceRecord> {
    const normalizedName = normalizeWorkspaceName(name);
    const baseSlug = slugifyWorkspace(normalizedName);
    for (let attempt = 1; attempt <= MAX_SLUG_ATTEMPTS; attempt += 1) {
      const slug = attempt === 1 ? baseSlug : `${baseSlug}-${attempt}`;
      try {
        return await this.database.transaction(async (transaction) => {
          const rows = await transaction.query<WorkspaceRow>({
            text: `
              INSERT INTO workspaces (name, slug)
              VALUES ($1, $2)
              RETURNING id, name, slug, created_at, updated_at;
            `,
            values: [normalizedName, slug],
          });
          const workspace = rows[0] ? toWorkspace(rows[0]) : null;
          if (!workspace) throw new Error('created workspace could not be loaded');
          await transaction.execute({
            text: `
              INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
              VALUES ($1, $2, 'owner', 'active');
            `,
            values: [workspace.id, ownerUserId],
          });
          return workspace;
        });
      } catch (error) {
        if (!workspaceSlugConflict(error)) throw error;
      }
    }
    throw new Error('workspace slug could not be allocated');
  }

  async findById(id: number): Promise<WorkspaceRecord | null> {
    const rows = await this.database.query<WorkspaceRow>({
      text: `
        SELECT id, name, slug, created_at, updated_at
        FROM workspaces WHERE id = $1 LIMIT 1;
      `,
      values: [id],
    });
    return rows[0] ? toWorkspace(rows[0]) : null;
  }

  findBySlug(slug: string): Promise<WorkspaceRecord | null> {
    return findWorkspaceBySlug(this.database, slug);
  }

  async listForUser(userId: number): Promise<Array<WorkspaceRecord & { role: WorkspaceRole }>> {
    const rows = await this.database.query<WorkspaceRow & { role: WorkspaceRole }>({
      text: `
        SELECT w.id, w.name, w.slug, w.created_at, w.updated_at, m.role
        FROM workspace_memberships m
        JOIN workspaces w ON w.id = m.workspace_id
        WHERE m.user_id = $1 AND m.status = 'active'
        ORDER BY w.id ASC;
      `,
      values: [userId],
    });
    return rows.map((row) => ({ ...toWorkspace(row), role: row.role }));
  }

  findMembership(workspaceId: number, userId: number): Promise<WorkspaceMembershipRecord | null> {
    return findMembership(this.database, workspaceId, userId);
  }

  async listMembers(workspaceId: number): Promise<WorkspaceMembershipRecord[]> {
    const rows = await this.database.query<MembershipRow>({
      text: `
        SELECT m.id, m.workspace_id, m.user_id, u.email, m.role, m.status,
          m.created_at, m.updated_at
        FROM workspace_memberships m
        JOIN users u ON u.id = m.user_id
        WHERE m.workspace_id = $1
        ORDER BY m.id ASC;
      `,
      values: [workspaceId],
    });
    return rows.map(toMembership);
  }

  async pendingInvitationCount(workspaceId: number, excludeEmail = ''): Promise<number> {
    const values: Array<string | number | Date> = [workspaceId, new Date()];
    let exclusion = '';
    if (excludeEmail) {
      values.push(excludeEmail);
      exclusion = 'AND email <> $3';
    }
    const rows = await this.database.query<{ count: number | string }>({
      text: `
        SELECT COUNT(*) AS count
        FROM workspace_invitations
        WHERE workspace_id = $1
          AND accepted_at IS NULL
          AND revoked_at IS NULL
          AND expires_at > $2
          ${exclusion};
      `,
      values,
    });
    return Number(rows[0]?.count ?? 0);
  }

  async validateInvitationTarget(workspaceId: number, value: unknown): Promise<string> {
    const email = normalizeEmail(value);
    if (await this.findMembershipByEmail(this.database, workspaceId, email)) {
      throw new Error('email is already a workspace member');
    }
    return email;
  }

  async principalForUser(userId: number, workspaceId?: number): Promise<PublicUserRecord | null> {
    const memberships = workspaceId
      ? [await findMembership(this.database, workspaceId, userId)].filter(Boolean) as WorkspaceMembershipRecord[]
      : await this.listMembershipsForUser(this.database, userId);
    const membership = memberships.find((candidate) => candidate.status === 'active');
    if (!membership) return null;
    return {
      id: membership.userId,
      workspaceId: membership.workspaceId,
      email: membership.email,
      role: membership.role,
    };
  }

  async createInvitation(input: {
    workspaceId: number;
    email: unknown;
    role: unknown;
    invitedByUserId: number;
  }): Promise<CreatedWorkspaceInvitation> {
    const email = normalizeEmail(input.email);
    const role = normalizeWorkspaceRole(input.role, false);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
    return this.database.transaction(async (transaction) => {
      if (await this.findMembershipByEmail(transaction, input.workspaceId, email)) {
        throw new Error('email is already a workspace member');
      }
      await transaction.execute({
        text: `
          UPDATE workspace_invitations
          SET revoked_at = CURRENT_TIMESTAMP
          WHERE workspace_id = $1 AND email = $2
            AND accepted_at IS NULL AND revoked_at IS NULL;
        `,
        values: [input.workspaceId, email],
      });
      const rows = await transaction.query<InvitationRow>({
        text: `
          INSERT INTO workspace_invitations (
            workspace_id, email, role, token_hash, invited_by_user_id, expires_at
          ) VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING id, workspace_id, email, role, expires_at,
            accepted_at, revoked_at, created_at;
        `,
        values: [
          input.workspaceId,
          email,
          role,
          hashInvitationToken(token),
          input.invitedByUserId,
          expiresAt,
        ],
      });
      if (!rows[0]) throw new Error('created invitation could not be loaded');
      return { ...toInvitation(rows[0]), token };
    });
  }

  async listInvitations(workspaceId: number): Promise<WorkspaceInvitationRecord[]> {
    const rows = await this.database.query<InvitationRow>({
      text: `
        SELECT id, workspace_id, email, role, expires_at, accepted_at, revoked_at, created_at
        FROM workspace_invitations
        WHERE workspace_id = $1
        ORDER BY id DESC;
      `,
      values: [workspaceId],
    });
    return rows.map(toInvitation);
  }

  revokeInvitation(workspaceId: number, invitationId: number): Promise<void> {
    return this.database.transaction(async (transaction) => {
      const invitation = await this.findInvitation(transaction, workspaceId, invitationId);
      if (!invitation) throw new Error('workspace invitation not found');
      if (invitation.acceptedAt) throw new Error('accepted invitation cannot be revoked');
      if (invitation.revokedAt) return;
      await transaction.execute({
        text: `
          UPDATE workspace_invitations SET revoked_at = CURRENT_TIMESTAMP
          WHERE workspace_id = $1 AND id = $2;
        `,
        values: [workspaceId, invitationId],
      });
    });
  }

  acceptInvitation(
    token: string,
    userId: number,
    userEmail: string,
  ): Promise<WorkspaceMembershipRecord> {
    if (!token.trim()) return Promise.reject(new Error('invitation is invalid or no longer active'));
    return this.database.transaction(async (transaction) => {
      const invitation = await this.findInvitationByToken(transaction, token);
      return this.acceptInvitationRecord(transaction, invitation, userId, userEmail);
    });
  }

  acceptInvitationById(
    workspaceId: number,
    invitationId: number,
    userId: number,
    userEmail: string,
  ): Promise<WorkspaceMembershipRecord> {
    return this.database.transaction(async (transaction) => {
      const invitation = await this.findInvitation(transaction, workspaceId, invitationId);
      return this.acceptInvitationRecord(transaction, invitation, userId, userEmail);
    });
  }

  async activeInvitationByToken(token: string): Promise<WorkspaceInvitationRecord | null> {
    const invitation = await this.findInvitationByToken(this.database, token);
    if (
      !invitation
      || invitation.revokedAt
      || invitation.acceptedAt
      || invitation.expiresAt <= new Date().toISOString()
    ) {
      return null;
    }
    return invitation;
  }

  updateMemberRole(
    workspaceId: number,
    userId: number,
    role: unknown,
  ): Promise<WorkspaceMembershipRecord> {
    const normalizedRole = normalizeWorkspaceRole(role, false);
    return this.database.transaction(async (transaction) => {
      const existing = await findMembership(transaction, workspaceId, userId);
      if (!existing) throw new Error('workspace member not found');
      if (existing.role === 'owner') throw new Error('workspace owner role cannot be changed');
      await transaction.execute({
        text: `
          UPDATE workspace_memberships
          SET role = $1, updated_at = CURRENT_TIMESTAMP
          WHERE workspace_id = $2 AND user_id = $3;
        `,
        values: [normalizedRole, workspaceId, userId],
      });
      const updated = await findMembership(transaction, workspaceId, userId);
      if (!updated) throw new Error('workspace member not found');
      return updated;
    });
  }

  removeMember(workspaceId: number, userId: number): Promise<void> {
    return this.database.transaction(async (transaction) => {
      const existing = await findMembership(transaction, workspaceId, userId);
      if (!existing) throw new Error('workspace member not found');
      if (existing.role === 'owner') throw new Error('workspace owner cannot be removed');
      await transaction.execute({
        text: 'DELETE FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2;',
        values: [workspaceId, userId],
      });
    });
  }

  private async acceptInvitationRecord(
    transaction: AsyncDatabaseSession,
    invitation: WorkspaceInvitationRecord | null,
    userId: number,
    userEmail: string,
  ): Promise<WorkspaceMembershipRecord> {
    if (!invitation || invitation.revokedAt || invitation.acceptedAt) {
      throw new Error('invitation is invalid or no longer active');
    }
    const now = new Date();
    if (invitation.expiresAt <= now.toISOString()) throw new Error('invitation has expired');
    if (normalizeEmail(userEmail) !== invitation.email) {
      throw new Error('invitation email does not match the signed-in user');
    }
    if (await findMembership(transaction, invitation.workspaceId, userId)) {
      throw new Error('user is already a workspace member');
    }
    const consumed = await transaction.execute({
      text: `
        UPDATE workspace_invitations
        SET accepted_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > $2;
      `,
      values: [invitation.id, now],
    });
    if (consumed.rowCount !== 1) throw new Error('invitation is invalid or no longer active');
    await transaction.execute({
      text: `
        INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
        VALUES ($1, $2, $3, 'active');
      `,
      values: [invitation.workspaceId, userId, invitation.role],
    });
    const membership = await findMembership(transaction, invitation.workspaceId, userId);
    if (!membership) throw new Error('accepted membership could not be loaded');
    return membership;
  }

  private async listMembershipsForUser(
    database: AsyncDatabaseSession,
    userId: number,
  ): Promise<WorkspaceMembershipRecord[]> {
    const rows = await database.query<MembershipRow>({
      text: `
        SELECT m.id, m.workspace_id, m.user_id, u.email, m.role, m.status,
          m.created_at, m.updated_at
        FROM workspace_memberships m
        JOIN users u ON u.id = m.user_id
        WHERE m.user_id = $1
        ORDER BY m.id ASC;
      `,
      values: [userId],
    });
    return rows.map(toMembership);
  }

  private async findMembershipByEmail(
    database: AsyncDatabaseSession,
    workspaceId: number,
    email: string,
  ): Promise<WorkspaceMembershipRecord | null> {
    const rows = await database.query<MembershipRow>({
      text: `
        SELECT m.id, m.workspace_id, m.user_id, u.email, m.role, m.status,
          m.created_at, m.updated_at
        FROM workspace_memberships m
        JOIN users u ON u.id = m.user_id
        WHERE m.workspace_id = $1 AND u.email = $2 AND m.status = 'active'
        LIMIT 1;
      `,
      values: [workspaceId, email],
    });
    return rows[0] ? toMembership(rows[0]) : null;
  }

  private findInvitation(
    database: AsyncDatabaseSession,
    workspaceId: number,
    invitationId: number,
  ): Promise<WorkspaceInvitationRecord | null> {
    return findInvitation(database, {
      text: `
        SELECT id, workspace_id, email, role, expires_at, accepted_at, revoked_at, created_at
        FROM workspace_invitations
        WHERE workspace_id = $1 AND id = $2
        LIMIT 1;
      `,
      values: [workspaceId, invitationId],
    });
  }

  private findInvitationByToken(
    database: AsyncDatabaseSession,
    token: string,
  ): Promise<WorkspaceInvitationRecord | null> {
    if (!token.trim()) return Promise.resolve(null);
    return findInvitation(database, {
      text: `
        SELECT id, workspace_id, email, role, expires_at, accepted_at, revoked_at, created_at
        FROM workspace_invitations
        WHERE token_hash = $1
        LIMIT 1;
      `,
      values: [hashInvitationToken(token)],
    });
  }
}
