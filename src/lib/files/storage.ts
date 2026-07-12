import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "@/lib/env";

export async function ensureStorage() {
  await Promise.all([
    mkdir(path.join(env.storageDir, "originals"), { recursive: true }),
    mkdir(path.join(env.storageDir, "attempts"), { recursive: true }),
    mkdir(path.join(env.storageDir, "exports"), { recursive: true }),
    mkdir(path.join(env.storageDir, "backups"), { recursive: true }),
  ]);
}

export function sha256(buffer: Buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export async function storeOriginal(batchId: string, fileName: string, buffer: Buffer) {
  await ensureStorage();
  const hash = sha256(buffer);
  const ext = path.extname(fileName) || ".jpg";
  const dir = path.join(env.storageDir, "originals", batchId);
  await mkdir(dir, { recursive: true });
  const storedPath = path.join(dir, `${hash}${ext}`);
  await writeFile(storedPath, buffer);
  return { hash, storedPath };
}
