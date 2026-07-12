import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";

/**
 * One-key test runner.
 *
 * Integration tests touch the database, so they must run against an isolated,
 * seed-free SQLite file instead of the developer's dev.db. This script:
 *   1. recreates a clean test.db,
 *   2. pushes the Prisma schema into it,
 *   3. runs the full test suite with DATABASE_URL pointed at test.db.
 *
 * Usage: pnpm test  (or  npm test)
 */

const root = path.resolve(import.meta.dirname, "..");
const testDbFile = path.join(root, "test.db");
const DATABASE_URL = "file:./test.db";

const childEnv: NodeJS.ProcessEnv = {
  ...process.env,
  DATABASE_URL,
  NODE_ENV: "test",
};

function run(command: string) {
  execSync(command, { cwd: root, env: childEnv, stdio: "inherit" });
}

function resetDatabaseFile() {
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    rmSync(`${testDbFile}${suffix}`, { force: true });
  }
}

console.log("[1/3] Resetting isolated test database (test.db) ...");
resetDatabaseFile();

console.log("[2/3] Pushing Prisma schema into test.db ...");
run("prisma db push");

console.log("[3/3] Running test suite against test.db ...");
run('tsx --test "src/**/*.test.ts"');

console.log("Tests finished.");
