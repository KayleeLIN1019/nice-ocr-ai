import { prisma } from "@/lib/db/client";
import type { DbClient } from "@/lib/db/types";
import { badRequest, notFound } from "@/lib/api/http";

/**
 * 队列维护动作：重试 / 取消 / 批量重试。
 *
 * 仅供队列路由与测试使用——刻意与 worker 依赖图隔离（worker 只用 jobs.ts，
 * 不应间接拉入 next/server）。所有写操作接受可选 DbClient，便于路由用
 * `prisma.$transaction` 包裹成原子操作、测试用回滚事务注入。
 *
 * 状态守卫与并发：只动「终态/排队态」，绝不触碰 worker 正在处理的 active，
 * 避免与 claimNextJob 乐观锁、reclaimStaleJobs 回收竞态。
 */

/** 重试一个失败作业：重置为 queued 并清空尝试/错误/锁，文档回到 queued。 */
export async function retryJob(jobId: string, db: DbClient = prisma) {
  const job = await db.recognitionJob.findUnique({ where: { id: jobId } });
  if (!job) throw notFound("作业不存在");
  if (job.status !== "failed") throw badRequest("仅识别失败的作业可重试");

  const updated = await db.recognitionJob.update({
    where: { id: jobId },
    data: {
      status: "queued",
      attemptsMade: 0,
      lastError: null,
      nextRunAt: new Date(),
      lockedAt: null,
      lockedBy: null,
    },
  });
  await db.document.update({ where: { id: job.documentId }, data: { status: "queued" } });
  await db.auditLog.create({
    data: {
      entityType: "RecognitionJob",
      entityId: jobId,
      action: "retry",
      beforeJson: JSON.stringify({ status: job.status }),
      afterJson: JSON.stringify({ status: "queued" }),
    },
  });
  return updated;
}

/** 取消一个排队作业：无尝试记录则删除；已有尝试记录则置 cancelled，文档置 cancelled。 */
export async function cancelJob(jobId: string, db: DbClient = prisma) {
  const job = await db.recognitionJob.findUnique({ where: { id: jobId } });
  if (!job) throw notFound("作业不存在");
  if (job.status !== "queued") throw badRequest("仅排队中的作业可取消");

  const attemptCount = await db.extractionAttempt.count({ where: { jobId } });
  let result: { id: string; documentId: string; status: "deleted" | "cancelled" };
  if (attemptCount === 0) {
    const deleted = await db.recognitionJob.deleteMany({ where: { id: jobId, status: "queued" } });
    if (deleted.count !== 1) throw badRequest("作业状态已变化，无法取消");
    result = { id: jobId, documentId: job.documentId, status: "deleted" };
  } else {
    const updated = await db.recognitionJob.updateMany({
      where: { id: jobId, status: "queued" },
      data: { status: "cancelled", lockedAt: null, lockedBy: null },
    });
    if (updated.count !== 1) throw badRequest("作业状态已变化，无法取消");
    result = { id: jobId, documentId: job.documentId, status: "cancelled" };
  }

  await db.document.update({ where: { id: job.documentId }, data: { status: "cancelled" } });
  await db.auditLog.create({
    data: {
      entityType: "RecognitionJob",
      entityId: jobId,
      action: "cancel",
      beforeJson: JSON.stringify({ status: job.status, documentId: job.documentId }),
    },
  });
  return result;
}

/** 批量重试所有失败作业（可限定批次）。返回受影响数量。 */
export async function retryFailedJobs(batchId: string | undefined, db: DbClient = prisma) {
  const where = { status: "failed", ...(batchId ? { batchId } : {}) };
  const failed = await db.recognitionJob.findMany({ where, select: { documentId: true } });
  if (!failed.length) return { count: 0 };

  const documentIds = [...new Set(failed.map((job) => job.documentId))];
  await db.recognitionJob.updateMany({
    where,
    data: {
      status: "queued",
      attemptsMade: 0,
      lastError: null,
      nextRunAt: new Date(),
      lockedAt: null,
      lockedBy: null,
    },
  });
  await db.document.updateMany({ where: { id: { in: documentIds } }, data: { status: "queued" } });
  await db.auditLog.create({
    data: {
      entityType: "RecognitionJob",
      entityId: "batch",
      action: "retry_failed",
      afterJson: JSON.stringify({ count: failed.length, batchId: batchId ?? null }),
    },
  });
  return { count: failed.length };
}
