import { type AccountEmailDispatcher } from './accountEmailDispatcher';
import { type AccountEmailOutboxStore } from './accountEmailOutboxStore';
import { type UsageExportDispatcher } from './usageExportDispatcher';
import { type UsageExportOutboxStore } from './usageExportOutboxStore';

export class OutboxDispatcherLifecycle {
  private active: boolean;
  private accountEmailDispatcher: AccountEmailDispatcher | undefined;
  private usageExportDispatcher: UsageExportDispatcher | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;

  constructor(enabled: boolean) {
    this.active = enabled;
  }

  get enabled(): boolean {
    return this.active;
  }

  attachAccountEmail(dispatcher: AccountEmailDispatcher): void {
    this.accountEmailDispatcher = dispatcher;
  }

  attachUsageExport(dispatcher: UsageExportDispatcher): void {
    this.usageExportDispatcher = dispatcher;
  }

  kickAccountEmail = (): void => {
    if (this.active) this.accountEmailDispatcher?.kick();
  };

  kickUsageExport = (): void => {
    if (this.active) this.usageExportDispatcher?.kick();
  };

  guardAccountEmailStore(store: AccountEmailOutboxStore): AccountEmailOutboxStore {
    return this.guardStore(store, new Set<PropertyKey>(['claimNext', 'nextAttemptDelayMs']));
  }

  guardUsageExportStore(store: UsageExportOutboxStore): UsageExportOutboxStore {
    return this.guardStore(store, new Set<PropertyKey>(['claimNext', 'nextAttemptDelayMs']));
  }

  start(pollIntervalMs = 1_000, unref = true): void {
    if (!this.active || this.pollTimer) return;
    this.poll();
    this.pollTimer = setInterval(() => this.poll(), pollIntervalMs);
    if (unref && typeof this.pollTimer === 'object' && 'unref' in this.pollTimer) {
      this.pollTimer.unref();
    }
  }

  async stop(): Promise<void> {
    this.active = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    await Promise.all([
      this.accountEmailDispatcher?.drain(),
      this.usageExportDispatcher?.drain(),
    ]);
  }

  private poll(): void {
    this.kickAccountEmail();
    this.kickUsageExport();
  }

  private guardStore<T extends object>(store: T, guardedMethods: Set<PropertyKey>): T {
    return new Proxy(store, {
      get: (target, property, receiver) => {
        if (guardedMethods.has(property) && !this.active) return () => null;
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }
}
