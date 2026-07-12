import { prisma } from "@/lib/db/client";
import type { DbClient } from "@/lib/db/types";
import { getRecognitionDefaults } from "@/lib/recognition/settings";

const IN_FLIGHT_JOB_STATUSES = ["queued", "active"] as const;

export async function enqueueRecognitionJob(
  documentId: string,
  batchId: string,
  type: "extract" | "second_pass" | "consensus" | "audit" = "extract",
  db: DbClient = prisma,
) {
  const existing = await db.recognitionJob.findFirst({
    where: {
      documentId,
      type,
      status: { in: [...IN_FLIGHT_JOB_STATUSES] },
    },
    orderBy: { createdAt: "asc" },
  });
  if (existing) return null;

  const defaults = await getRecognitionDefaults(db);
  return db.recognitionJob.create({
    data: {
      documentId,
      batchId,
      type,
      status: "queued",
      maxAttempts: defaults.maxAttempts,
    },
  });
}

export async function enqueueSecondPassIfNeeded(
  documentId: string,
  batchId: string,
  db: DbClient = prisma,
) {
  const existing = await db.recognitionJob.count({
    where: {
      documentId,
      type: "second_pass",
    },
  });
  if (existing > 0) return null;
  return enqueueRecognitionJob(documentId, batchId, "second_pass", db);
}

/** 入队一个文档的审核(二次复查)任务，避免重复排队。返回 null 表示已有未完成审核任务。 */
export async function enqueueAuditJob(documentId: string, batchId: string, db: DbClient = prisma) {
  return enqueueRecognitionJob(documentId, batchId, "audit", db);
}

/**
 * 乐观锁原子领取下一个待处理 job。
 *
 * 先选候选，再用带 `status: "queued"` 条件的 updateMany 抢占；只有 count===1 才算领到，
 * 否则说明已被并发 worker 抢走，重试下一个候选。这样消除了“先 findFirst 再 update”
 * 的读改竞态——多 worker 进程 / worker 内并发领取都不会重复处理同一 job。
 */
export async function claimNextJob(workerId: string, db: DbClient = prisma) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = await db.recognitionJob.findFirst({
      where: { status: "queued", nextRunAt: { lte: new Date() } },
      orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
      select: { id: true },
    });
    if (!candidate) return null;

    const claimed = await db.recognitionJob.updateMany({
      where: { id: candidate.id, status: "queued" },
      data: {
        status: "active",
        lockedAt: new Date(),
        lockedBy: workerId,
        attemptsMade: { increment: 1 },
      },
    });

    if (claimed.count === 1) {
      return db.recognitionJob.findUnique({
        where: { id: candidate.id },
        include: { document: true, batch: true },
      });
    }
    // 被并发抢走，试下一个候选。
  }
  return null;
}
