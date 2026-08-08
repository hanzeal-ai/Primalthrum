import {
  type AuthenticatedOperatorSession,
  type CreatedOperatorSession,
  type OperatorCredentialsRecord,
  type OperatorUserRecord,
} from './operatorIdentityRepository';
import { type Awaitable } from './storeTypes';

export interface CreateOperatorInput {
  email: unknown;
  passwordHash: string;
  role: unknown;
}

export interface OperatorIdentityStore {
  needsSetup(): Awaitable<boolean>;
  createInitial(email: unknown, passwordHash: string): Awaitable<OperatorUserRecord>;
  create(input: CreateOperatorInput): Awaitable<OperatorUserRecord>;
  list(): Awaitable<OperatorUserRecord[]>;
  findCredentialsByEmail(email: unknown): Awaitable<OperatorCredentialsRecord | null>;
  findById(id: number): Awaitable<OperatorUserRecord | null>;
  createSession(userId: number): Awaitable<CreatedOperatorSession>;
  findByToken(token: string): Awaitable<AuthenticatedOperatorSession | null>;
  revokeToken(token: string): Awaitable<void>;
  updatePassword(userId: number, passwordHash: string): Awaitable<void>;
}
