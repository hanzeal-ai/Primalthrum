import { type Awaitable } from './storeTypes';
import { type PublicUserRecord, type UserRecord } from './userRepository';

export interface UserStore {
  hasAdmin(): Awaitable<boolean>;
  createAdmin(email: string, passwordHash: string): Awaitable<PublicUserRecord>;
  createUser(email: string, passwordHash: string, emailVerified?: boolean): Awaitable<UserRecord>;
  findByEmail(email: string): Awaitable<UserRecord | null>;
  findById(id: number): Awaitable<UserRecord | null>;
  markEmailVerified(userId: number, verifiedAt?: string): Awaitable<void>;
  updatePassword(userId: number, passwordHash: string): Awaitable<void>;
}
