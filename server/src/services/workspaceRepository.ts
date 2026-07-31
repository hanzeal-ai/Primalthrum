import { createHash, randomBytes } from 'node:crypto';

import { initializeSchema } from '../db/schema';
import { SqliteDatabase, sqlValue } from '../db/sqlite';
import { normalizeEmail, type PublicUserRecord } from './userRepository';

export const WORKSPACE_ROLES = [
  'owner',
  'admin',
  'developer',
  'member',
  'billing',
  'viewer',
] as const;
export type WorkspaceRole = typeof WORKSPACE_ROLES[number];

export interface WorkspaceRecord {
  id: number;
  name: string;
  slug: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceMembershipRecord {
  id: number;
  workspaceId: number;
  userId: number;
  email: string;
  role: WorkspaceRole;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceInvitationRecord {
  id: number;
  workspaceId: number;
  email: string;
  role: WorkspaceRole;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface CreatedWorkspaceInvitation extends WorkspaceInvitationRecord {
  token: string;
}

interface WorkspaceRow {
  id: number;
  name: string;
  slug: string;
  created_at: string;
  updated_at: string;
}

interface MembershipRow {
  id: number;
  workspace_id: number;
  user_id: number;
  email: string;
  role: WorkspaceRole;
  status: string;
  created_at: string;
  updated_at: string;
}

interface InvitationRow {
  id: number;
  workspace_id: number;
  email: string;
  role: WorkspaceRole;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

const INVITATION_TTL_MS = 1000 * 60 * 60 * 24 * 7;

export class WorkspaceRepository {
  constructor(private readonly db: SqliteDatabase) {
    initializeSchema(db);
  }

  create(ownerUserId: number, name: unknown): WorkspaceRecord {
    const normalizedName = normalizeWorkspaceName(name);
    const slug = this.nextSlug(slugifyWorkspace(normalizedName));
    this.db.run(`
      INSERT INTO workspaces (name, slug)
      VALUES (${sqlValue(normalizedName)}, ${sqlValue(slug)});

      INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
      VALUES (
        (SELECT id FROM workspaces WHERE slug = ${sqlValue(slug)}),
        ${sqlValue(ownerUserId)},
        'owner',
        'active'
      );
    `);
    const created = this.findBySlug(slug);
    if (!created) throw new Error('created workspace could not be loaded');
    return created;
  }

  findById(id: number): WorkspaceRecord | null {
    const rows = this.db.query<WorkspaceRow>(`
      SELECT id, name, slug, created_at, updated_at
      FROM workspaces
      WHERE id = ${sqlValue(id)}
      LIMIT 1;
    `);
    return rows[0] ? toWorkspace(rows[0]) : null;
  }

  findBySlug(slug: string): WorkspaceRecord | null {
    const rows = this.db.query<WorkspaceRow>(`
      SELECT id, name, slug, created_at, updated_at
      FROM workspaces
      WHERE slug = ${sqlValue(slug)}
      LIMIT 1;
    `);
    return rows[0] ? toWorkspace(rows[0]) : null;
  }

  listForUser(userId: number): Array<WorkspaceRecord & { role: WorkspaceRole }> {
    return this.db.query<WorkspaceRow & { role: WorkspaceRole }>(`
      SELECT w.id, w.name, w.slug, w.created_at, w.updated_at, m.role
      FROM workspace_memberships m
      JOIN workspaces w ON w.id = m.workspace_id
      WHERE m.user_id = ${sqlValue(userId)} AND m.status = 'active'
      ORDER BY w.id ASC;
    `).map((row) => ({ ...toWorkspace(row), role: row.role }));
  }

  findMembership(workspaceId: number, userId: number): WorkspaceMembershipRecord | null {
    const rows = this.db.query<MembershipRow>(`
      SELECT
        m.id,
        m.workspace_id,
        m.user_id,
        u.email,
        m.role,
        m.status,
        m.created_at,
        m.updated_at
      FROM workspace_memberships m
      JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = ${sqlValue(workspaceId)}
        AND m.user_id = ${sqlValue(userId)}
      LIMIT 1;
    `);
    return rows[0] ? toMembership(rows[0]) : null;
  }

  listMembers(workspaceId: number): WorkspaceMembershipRecord[] {
    return this.db.query<MembershipRow>(`
      SELECT
        m.id,
        m.workspace_id,
        m.user_id,
        u.email,
        m.role,
        m.status,
        m.created_at,
        m.updated_at
      FROM workspace_memberships m
      JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = ${sqlValue(workspaceId)}
      ORDER BY m.id ASC;
    `).map(toMembership);
  }

  pendingInvitationCount(workspaceId: number, excludeEmail = ''): number {
    const now = new Date().toISOString();
    return Number(this.db.query<{ count: number }>(`
      SELECT COUNT(*) AS count
      FROM workspace_invitations
      WHERE workspace_id = ${sqlValue(workspaceId)}
        AND accepted_at IS NULL
        AND revoked_at IS NULL
        AND expires_at > ${sqlValue(now)}
        ${excludeEmail ? `AND email <> ${sqlValue(excludeEmail)}` : ''};
    `)[0]?.count ?? 0);
  }

  validateInvitationTarget(workspaceId: number, value: unknown): string {
    const email = normalizeEmail(value);
    if (this.findMembershipByEmail(workspaceId, email)) {
      throw new Error('email is already a workspace member');
    }
    return email;
  }

  principalForUser(userId: number, workspaceId?: number): PublicUserRecord | null {
    const memberships = workspaceId
      ? [this.findMembership(workspaceId, userId)].filter(Boolean) as WorkspaceMembershipRecord[]
      : this.listMembershipsForUser(userId);
    const membership = memberships.find((candidate) => candidate.status === 'active');
    if (!membership) return null;
    return {
      id: membership.userId,
      workspaceId: membership.workspaceId,
      email: membership.email,
      role: membership.role,
    };
  }

  createInvitation(input: {
    workspaceId: number;
    email: unknown;
    role: unknown;
    invitedByUserId: number;
  }): CreatedWorkspaceInvitation {
    const email = this.validateInvitationTarget(input.workspaceId, input.email);
    const role = normalizeWorkspaceRole(input.role, false);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS).toISOString();
    this.db.run(`
      UPDATE workspace_invitations
      SET revoked_at = CURRENT_TIMESTAMP
      WHERE workspace_id = ${sqlValue(input.workspaceId)}
        AND email = ${sqlValue(email)}
        AND accepted_at IS NULL
        AND revoked_at IS NULL;

      INSERT INTO workspace_invitations (
        workspace_id,
        email,
        role,
        token_hash,
        invited_by_user_id,
        expires_at
      ) VALUES (
        ${sqlValue(input.workspaceId)},
        ${sqlValue(email)},
        ${sqlValue(role)},
        ${sqlValue(hashInvitationToken(token))},
        ${sqlValue(input.invitedByUserId)},
        ${sqlValue(expiresAt)}
      );
    `);
    const invitation = this.findInvitationByToken(token);
    if (!invitation) throw new Error('created invitation could not be loaded');
    return { ...invitation, token };
  }

  listInvitations(workspaceId: number): WorkspaceInvitationRecord[] {
    return this.db.query<InvitationRow>(`
      SELECT id, workspace_id, email, role, expires_at, accepted_at, revoked_at, created_at
      FROM workspace_invitations
      WHERE workspace_id = ${sqlValue(workspaceId)}
      ORDER BY id DESC;
    `).map(toInvitation);
  }

  revokeInvitation(workspaceId: number, invitationId: number): void {
    const invitation = this.findInvitation(workspaceId, invitationId);
    if (!invitation) throw new Error('workspace invitation not found');
    if (invitation.acceptedAt) throw new Error('accepted invitation cannot be revoked');
    if (invitation.revokedAt) return;
    this.db.run(`
      UPDATE workspace_invitations
      SET revoked_at = CURRENT_TIMESTAMP
      WHERE workspace_id = ${sqlValue(workspaceId)} AND id = ${sqlValue(invitationId)};
    `);
  }

  acceptInvitation(token: string, userId: number, userEmail: string): WorkspaceMembershipRecord {
    const invitation = this.findInvitationByToken(token);
    if (!invitation || invitation.revokedAt || invitation.acceptedAt) {
      throw new Error('invitation is invalid or no longer active');
    }
    if (invitation.expiresAt <= new Date().toISOString()) {
      throw new Error('invitation has expired');
    }
    if (normalizeEmail(userEmail) !== invitation.email) {
      throw new Error('invitation email does not match the signed-in user');
    }
    if (this.findMembership(invitation.workspaceId, userId)) {
      throw new Error('user is already a workspace member');
    }
    this.db.run(`
      INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
      VALUES (
        ${sqlValue(invitation.workspaceId)},
        ${sqlValue(userId)},
        ${sqlValue(invitation.role)},
        'active'
      );

      UPDATE workspace_invitations
      SET accepted_at = CURRENT_TIMESTAMP
      WHERE id = ${sqlValue(invitation.id)};
    `);
    const membership = this.findMembership(invitation.workspaceId, userId);
    if (!membership) throw new Error('accepted membership could not be loaded');
    return membership;
  }

  activeInvitationByToken(token: string): WorkspaceInvitationRecord | null {
    const invitation = this.findInvitationByToken(token);
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

  updateMemberRole(workspaceId: number, userId: number, role: unknown): WorkspaceMembershipRecord {
    const normalizedRole = normalizeWorkspaceRole(role, false);
    const existing = this.findMembership(workspaceId, userId);
    if (!existing) throw new Error('workspace member not found');
    if (existing.role === 'owner') throw new Error('workspace owner role cannot be changed');
    this.db.run(`
      UPDATE workspace_memberships
      SET role = ${sqlValue(normalizedRole)}, updated_at = CURRENT_TIMESTAMP
      WHERE workspace_id = ${sqlValue(workspaceId)}
        AND user_id = ${sqlValue(userId)};
    `);
    const updated = this.findMembership(workspaceId, userId);
    if (!updated) throw new Error('workspace member not found');
    return updated;
  }

  removeMember(workspaceId: number, userId: number): void {
    const existing = this.findMembership(workspaceId, userId);
    if (!existing) throw new Error('workspace member not found');
    if (existing.role === 'owner') throw new Error('workspace owner cannot be removed');
    this.db.run(`
      DELETE FROM workspace_memberships
      WHERE workspace_id = ${sqlValue(workspaceId)}
        AND user_id = ${sqlValue(userId)};
    `);
  }

  private listMembershipsForUser(userId: number): WorkspaceMembershipRecord[] {
    return this.db.query<MembershipRow>(`
      SELECT
        m.id,
        m.workspace_id,
        m.user_id,
        u.email,
        m.role,
        m.status,
        m.created_at,
        m.updated_at
      FROM workspace_memberships m
      JOIN users u ON u.id = m.user_id
      WHERE m.user_id = ${sqlValue(userId)}
      ORDER BY m.id ASC;
    `).map(toMembership);
  }

  private findMembershipByEmail(workspaceId: number, email: string): WorkspaceMembershipRecord | null {
    const row = this.db.query<MembershipRow>(`
      SELECT m.id, m.workspace_id, m.user_id, u.email, m.role, m.status,
        m.created_at, m.updated_at
      FROM workspace_memberships m
      JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = ${sqlValue(workspaceId)}
        AND u.email = ${sqlValue(email)}
        AND m.status = 'active'
      LIMIT 1;
    `)[0];
    return row ? toMembership(row) : null;
  }

  private findInvitation(workspaceId: number, invitationId: number): WorkspaceInvitationRecord | null {
    const row = this.db.query<InvitationRow>(`
      SELECT id, workspace_id, email, role, expires_at, accepted_at, revoked_at, created_at
      FROM workspace_invitations
      WHERE workspace_id = ${sqlValue(workspaceId)} AND id = ${sqlValue(invitationId)}
      LIMIT 1;
    `)[0];
    return row ? toInvitation(row) : null;
  }

  private findInvitationByToken(token: string): WorkspaceInvitationRecord | null {
    if (!token.trim()) return null;
    const rows = this.db.query<InvitationRow>(`
      SELECT id, workspace_id, email, role, expires_at, accepted_at, revoked_at, created_at
      FROM workspace_invitations
      WHERE token_hash = ${sqlValue(hashInvitationToken(token))}
      LIMIT 1;
    `);
    return rows[0] ? toInvitation(rows[0]) : null;
  }

  private nextSlug(base: string): string {
    let slug = base;
    let suffix = 2;
    while (this.findBySlug(slug)) {
      slug = `${base}-${suffix}`;
      suffix += 1;
    }
    return slug;
  }
}

export function normalizeWorkspaceRole(value: unknown, allowOwner: boolean): WorkspaceRole {
  const role = typeof value === 'string' ? value.trim() : '';
  if (!WORKSPACE_ROLES.includes(role as WorkspaceRole) || (!allowOwner && role === 'owner')) {
    const roles = WORKSPACE_ROLES.filter((candidate) => allowOwner || candidate !== 'owner');
    throw new Error(`role must be ${roles.join(', ')}`);
  }
  return role as WorkspaceRole;
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toInvitation(row: InvitationRow): WorkspaceInvitationRecord {
  return {
    id: Number(row.id),
    workspaceId: Number(row.workspace_id),
    email: row.email,
    role: row.role,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}
