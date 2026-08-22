import type Database from "better-sqlite3";
import { initialSchema } from "./001-initial-schema";
import { costCurrency } from "./002-cost-currency";

export interface Migration {
  version: number;
  name: string;
  up(db: Database.Database): void;
}

export const DATABASE_MIGRATIONS: readonly Migration[] = [initialSchema, costCurrency];

function validateMigrations(migrations: readonly Migration[]): void {
  migrations.forEach((migration, index) => {
    const expected = index + 1;
    if (migration.version !== expected) {
      throw new Error(
        `Database migrations must be contiguous; expected version ${expected}, got ${migration.version}.`,
      );
    }
  });
}

/** Apply every pending forward migration atomically and reject databases created by newer code. */
export function migrateDatabase(db: Database.Database, migrations: readonly Migration[] = DATABASE_MIGRATIONS): void {
  validateMigrations(migrations);
  const current = db.pragma("user_version", { simple: true }) as number;
  const latest = migrations.at(-1)?.version ?? 0;

  if (current > latest) {
    throw new Error(`Database version ${current} is newer than the supported version ${latest}.`);
  }

  db.transaction(() => {
    for (const migration of migrations) {
      if (migration.version <= current) continue;
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
    }
  })();
}
