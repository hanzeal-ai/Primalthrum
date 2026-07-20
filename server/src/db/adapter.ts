export interface DatabaseAdapter {
  run(sql: string): void;
  query<T extends object>(sql: string): T[];
}
