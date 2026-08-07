import { type Awaitable } from './storeTypes';
import {
  type AuthenticatedSession,
  type CreatedSession,
  type SessionSecurityRecord,
} from './sessionRepository';
import { type PublicUserRecord } from './userRepository';

export interface SessionStore {
  create(user: PublicUserRecord, authenticationMethod?: string): Awaitable<CreatedSession>;
  findByToken(token: string): Awaitable<AuthenticatedSession | null>;
  revokeToken(token: string): Awaitable<void>;
  revokeAllForUser(userId: number): Awaitable<void>;
  listForUser(userId: number, currentToken: string): Awaitable<SessionSecurityRecord[]>;
  revokeForUser(userId: number, sessionId: number, currentToken: string): Awaitable<void>;
  revokeOthers(userId: number, currentToken: string): Awaitable<number>;
  markMfaAuthenticated(
    token: string,
    userId: number,
    authenticationMethod?: string,
  ): Awaitable<void>;
  markPasswordAuthenticated(token: string, userId: number): Awaitable<void>;
  switchWorkspace(token: string, userId: number, workspaceId: number): Awaitable<void>;
}
