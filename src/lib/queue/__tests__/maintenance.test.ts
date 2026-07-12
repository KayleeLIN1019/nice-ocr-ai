import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../db/client";
import { cancelJob, retryFailedJobs, retryJob } from "../maintenance";

const rollback = Symbol("rollback");

async function withRollback(callback: (tx: Prisma.TransactionClient) => Promise<void>) {
  try {
    await prisma.$transaction(async (tx) => {
      await callback(tx);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}

/** 建一个批次 + 文档，并按指定状态建一个 job。返回 { batchId, documentId, jobId }。 */
async function seedJob(
  tx: Prisma.TransactionClient,
  jobStatus: string,
  documentStatus: string,
  jobOverrides: Record<string, unknown> = {},
) {
  const batch = await tx.batch.create({ data: { name: "maint-test" } });
  const doc = await tx.document.create({
    data: {
      batchId: batch.id,
      originalName: "t.png",
      storedPath: "/tmp/t.png",
      hash: `h-${batch.id}`,
      mimeType: "image/png",
      sizeBytes: 1,
      status: documentStatus,
    },
  });
  const job = await tx.recognitionJob.create({
    data: { batchId: batch.id, documentId: doc.id, type: "extract", status: jobStatus, ...jobOverrides },
  });
  return { batchId: batch.id, documentId: doc.id, jobId: job.id };
}

describe("retryJob 重试失败作业", () => {
  it("把 failed 作业重置为 queued、清空尝试/错误，文档回到 queued", async () => {
    await withRollback(async (tx) => {
      const { jobId, documentId } = await seedJob(tx, "failed", "failed", {
        attemptsMade: 3,
        lastError: "boom",
      });

      const updated = await retryJob(jobId, tx);
      assert.equal(updated.status, "queued");
      assert.equal(updated.attemptsMade, 0);
      assert.equal(updated.lastError, null);

      const doc = await tx.document.findUnique({ where: { id: documentId } });
      assert.equal(doc?.status, "queued");
    });
  });

  it("非 failed 作业不可重试（抛错）", async () => {
    await withRollback(async (tx) => {
      const { jobId } = await seedJob(tx, "queued", "queued");
      await assert.rejects(() => retryJob(jobId, tx), /仅识别失败的作业可重试/);
    });
  });

  it("作业不存在时抛 404 文案", async () => {
    await withRollback(async (tx) => {
      await assert.rejects(() => retryJob("non-existent", tx), /作业不存在/);
    });
  });
});

describe("cancelJob 取消排队作业", () => {
  it("删除没有尝试记录的 queued 作业并把文档置 cancelled", async () => {
    await withRollback(async (tx) => {
      const { jobId, documentId } = await seedJob(tx, "queued", "queued");

      const result = await cancelJob(jobId, tx);
      assert.equal(result.id, jobId);
      assert.equal(result.status, "deleted");

      const job = await tx.recognitionJob.findUnique({ where: { id: jobId } });
      assert.equal(job, null, "无尝试记录的 job 应从队列删除");

      const doc = await tx.document.findUnique({ where: { id: documentId } });
      assert.equal(doc?.status, "cancelled");
    });
  });

  it("已有尝试记录的 queued 作业不可物理删除，改置 cancelled", async () => {
    await withRollback(async (tx) => {
      const { jobId, documentId } = await seedJob(tx, "queued", "queued");
      await tx.extractionAttempt.create({
        data: {
          documentId,
          jobId,
          providerKey: "test",
          model: "test-model",
          promptVersion: "v1",
          schemaVersion: "v1",
          strategy: "balanced",
          status: "failed",
        },
      });

      const result = await cancelJob(jobId, tx);
      assert.equal(result.status, "cancelled");

      const job = await tx.recognitionJob.findUnique({ where: { id: jobId } });
      assert.equal(job?.status, "cancelled");
    });
  });

  it("非排队作业（active）不可取消（抛错）", async () => {
    await withRollback(async (tx) => {
      const { jobId } = await seedJob(tx, "active", "processing");
      await assert.rejects(() => cancelJob(jobId, tx), /仅排队中的作业可取消/);
    });
  });
});

describe("retryFailedJobs 批量重试", () => {
  it("把所有 failed 作业重排，返回受影响数量", async () => {
    await withRollback(async (tx) => {
      const a = await seedJob(tx, "failed", "failed");
      const b = await seedJob(tx, "failed", "failed");
      await seedJob(tx, "queued", "queued"); // 不应被计入

      const result = await retryFailedJobs(undefined, tx);
      assert.equal(result.count, 2);

      const stillFailed = await tx.recognitionJob.count({ where: { status: "failed" } });
      assert.equal(stillFailed, 0);

      for (const seed of [a, b]) {
        const doc = await tx.document.findUnique({ where: { id: seed.documentId } });
        assert.equal(doc?.status, "queued");
      }
    });
  });

  it("无失败作业时返回 0", async () => {
    await withRollback(async (tx) => {
      await seedJob(tx, "queued", "queued");
      const result = await retryFailedJobs(undefined, tx);
      assert.equal(result.count, 0);
    });
  });
});
