import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.js';

// src/db and dist/db are both two levels below apps/api, where `drizzle/` lives.
const MIGRATIONS = fileURLToPath(new URL('../../drizzle', import.meta.url));

@Injectable()
export class DbService implements OnModuleDestroy {
  private readonly sqlite: Database.Database;
  readonly orm: BetterSQLite3Database<typeof schema>;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.sqlite = new Database(path);
    this.sqlite.pragma('journal_mode = WAL');
    this.sqlite.pragma('foreign_keys = ON');
    this.orm = drizzle(this.sqlite, { schema });
    migrate(this.orm, { migrationsFolder: MIGRATIONS });
  }

  /** `SELECT 1`; throws if the database is unusable. */
  ping(): void {
    this.sqlite.prepare('SELECT 1').get();
  }

  onModuleDestroy(): void {
    this.sqlite.close();
  }
}
