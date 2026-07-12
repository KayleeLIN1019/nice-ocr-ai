import { prisma } from "@/lib/db/client";
import type { DbClient } from "@/lib/db/types";

export type ConflictResolution = "resolved" | "ignored";

/**
 * 处理产品库冲突：标记为已解决或忽略。
 * 冲突不存在时返回 null（调用方应回 404）。
 */
export async function resolveProductConflict(
  id: string,
  options: { status?: ConflictResolution; note?: string | null } = {},
  db: DbClient = prisma,
) {
  const existing = await db.productConflict.findUnique({ where: { id } });
  if (!existing) return null;

  const status: ConflictResolution = options.status === "ignored" ? "ignored" : "resolved";
  return db.productConflict.update({
    where: { id },
    data: {
      status,
      resolutionNote: options.note ? String(options.note) : null,
      resolvedAt: new Date(),
    },
  });
}
