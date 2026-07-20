export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  level: LogLevel;
  message: string;
  code?: string;
  context?: Record<string, unknown>;
  timestamp?: string;
}

export interface StructuredLogger {
  log(entry: LogEntry): void;
}

export class JsonConsoleLogger implements StructuredLogger {
  log(entry: LogEntry): void {
    const payload = {
      timestamp: entry.timestamp ?? new Date().toISOString(),
      level: entry.level,
      message: entry.message,
      ...(entry.code ? { code: entry.code } : {}),
      ...(entry.context ? { context: entry.context } : {}),
    };
    const line = JSON.stringify(payload);
    if (entry.level === 'error') {
      console.error(line);
      return;
    }
    console.log(line);
  }
}
