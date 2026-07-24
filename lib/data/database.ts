// Owns the application-wide SQLite connection, migrations, and backup boundary. Feature stores own
// their queries, while opening this database guarantees that every domain schema is ready.
import { mkdirSync } from "fs";
import path from "path";
import Database from "better-sqlite3";
import { WORKSPACES_ROOT } from "../infra/paths";
import { migrateDatabase } from "./migrations";

export const PAODO_DB_FILE = path.join(/* turbopackIgnore: true */ WORKSPACES_ROOT, ".paodo.db");

type AppDataGlobal = typeof global & {
  _paodoDataDb?: Database.Database;
  _paodoDataDbFile?: string;
};

const g = global as AppDataGlobal;

export function appDataDb(): Database.Database {
  if (g._paodoDataDb && g._paodoDataDbFile === PAODO_DB_FILE) return g._paodoDataDb;
  if (g._paodoDataDb?.open) g._paodoDataDb.close();

  mkdirSync(path.dirname(PAODO_DB_FILE), { recursive: true });
  const conn = new Database(PAODO_DB_FILE);
  try {
    conn.pragma("journal_mode = WAL");
    conn.pragma("synchronous = FULL");
    conn.pragma("foreign_keys = ON");
    conn.pragma("busy_timeout = 5000");
    migrateDatabase(conn);
  } catch (err) {
    conn.close();
    throw err;
  }

  g._paodoDataDb = conn;
  g._paodoDataDbFile = PAODO_DB_FILE;
  return conn;
}

export function invalidateAppDataDb(): void {
  if (g._paodoDataDb?.open) g._paodoDataDb.close();
  delete g._paodoDataDb;
  delete g._paodoDataDbFile;
}

export async function backupAppDataDb(destination: string): Promise<void> {
  if (!destination.trim()) throw new Error("A database backup destination is required.");
  const resolved = path.resolve(destination);
  if (resolved === path.resolve(PAODO_DB_FILE)) {
    throw new Error("The database backup must not overwrite the live database.");
  }
  mkdirSync(path.dirname(resolved), { recursive: true });
  await appDataDb().backup(resolved);
}
