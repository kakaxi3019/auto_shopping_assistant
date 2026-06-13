declare module 'sql.js' {
  interface SqlJsDatabase {
    run(sql: string, params?: unknown[]): { changes: number }
    exec(sql: string, params?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>
    prepare(sql: string): SqlJsStatement
    export(): Uint8Array
    close(): void
  }

  interface SqlJsStatement {
    bind(params?: unknown[]): boolean
    step(): boolean
    getAsObject(): Record<string, unknown>
    free(): boolean
  }

  interface SqlJsStatic {
    (config?: { locateFile?: (filename: string) => string }): Promise<SqlJsStatic>
    Database: new (data?: ArrayLike<number>) => SqlJsDatabase
  }

  export default function initSqlJs(config?: { locateFile?: (filename: string) => string }): Promise<SqlJsStatic>
  export type Database = SqlJsDatabase
}
