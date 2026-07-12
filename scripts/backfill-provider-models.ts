import "dotenv/config";

import path from "node:path";
import Database from "better-sqlite3";
import { env } from "@/lib/env";

function main() {
  const dbPath = sqliteFilePath(env.databaseUrl);
  if (!dbPath) {
    console.log("provider model backfill skipped: DATABASE_URL is not a file: SQLite URL");
    return;
  }

  const db = new Database(dbPath);
  try {
    if (!tableExists(db, "AiProviderConfig")) return;
    if (!columnExists(db, "AiProviderConfig", "model")) return;

    db.exec(`
      CREATE TABLE IF NOT EXISTS "AiProviderModel" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "providerId" TEXT NOT NULL,
        "modelId" TEXT NOT NULL,
        "displayName" TEXT NOT NULL DEFAULT '',
        "enabled" BOOLEAN NOT NULL DEFAULT true,
        "priority" INTEGER NOT NULL DEFAULT 100,
        "source" TEXT NOT NULL DEFAULT 'manual',
        "metadataJson" TEXT NOT NULL DEFAULT '{}',
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "AiProviderModel_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "AiProviderConfig" ("id") ON DELETE RESTRICT ON UPDATE RESTRICT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "AiProviderModel_providerId_modelId_key" ON "AiProviderModel"("providerId", "modelId");
      CREATE INDEX IF NOT EXISTS "AiProviderModel_providerId_enabled_priority_idx" ON "AiProviderModel"("providerId", "enabled", "priority");
      CREATE INDEX IF NOT EXISTS "AiProviderModel_source_idx" ON "AiProviderModel"("source");
    `);

    const providers = db
      .prepare<[], { id: string; model: string }>(
        `SELECT "id", "model" FROM "AiProviderConfig" WHERE TRIM(COALESCE("model", '')) <> ''`,
      )
      .all();
    const insert = db.prepare(`
      INSERT OR IGNORE INTO "AiProviderModel"
        ("id", "providerId", "modelId", "displayName", "enabled", "priority", "source", "metadataJson", "createdAt", "updatedAt")
      VALUES
        (?, ?, ?, ?, true, 100, 'manual', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);
    const run = db.transaction(() => {
      for (const provider of providers) {
        insert.run(cuid(), provider.id, provider.model, provider.model);
      }
    });
    run();
    console.log(`provider model backfill complete: ${providers.length} provider rows inspected`);
  } finally {
    db.close();
  }
}

function sqliteFilePath(url: string) {
  if (!url.startsWith("file:")) return null;
  const file = url.slice("file:".length);
  return path.resolve(process.cwd(), file);
}

function tableExists(db: Database.Database, table: string) {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
  );
}

function columnExists(db: Database.Database, table: string, column: string) {
  return db.prepare(`PRAGMA table_info("${table}")`).all().some((entry) => {
    return typeof entry === "object" && entry !== null && (entry as { name?: unknown }).name === column;
  });
}

function cuid() {
  return `cm${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

main();
