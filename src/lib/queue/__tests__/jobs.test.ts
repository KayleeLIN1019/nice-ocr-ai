import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../db/client";
import { claimNextJob, enqueueRecognitionJob } from "../jobs";

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

async function seedJobs(tx: Prisma.TransactionClient, jobCount: number) {
  const batch = await tx.batch.create({ data: { name: "claim-test" } });
  for (let i = 0; i < jobCount; i += 1) {
    const doc = await tx.document.create({
      data: {
        batchId: batch.id,
        originalName: `t-${i}.png`,
        storedPath: `/tmp/t-${i}.png`,
        hash: `h-${batch.id}-${i}`,
        mimeType: "image/png",
        sizeBytes: 1,
      },
    });
    await enqueueRecognitionJob(doc.id, batch.id, "extract", tx);
  }
}

describe("claimNextJob 原子领取", () => {
  it("领取后标记为 active 且不会重复领取同一个 job", async () => {
    await withRollback(async (tx) => {
      await seedJobs(tx, 3);

      const first = await claimNextJob("worker-test", tx);
      const second = await claimNextJob("worker-test", tx);
      const third = await claimNextJob("worker-test", tx);
      const fourth = await claimNextJob("worker-test", tx);

      assert.ok(first && second && third, "前三次应各领到一个 job");
      assert.equal(first.status, "active");
      assert.equal(first.lockedBy, "worker-test");
      assert.equal(first.attemptsMade, 1, "领取时 attemptsMade 自增");

      const ids = new Set([first.id, second.id, third.id]);
      assert.equal(ids.size, 3, "三次领到的 job id 互不相同（status=queued 守卫生效）");
      assert.equal(fourth, null, "queued 用尽后应返回 null");

      const remaining = await tx.recognitionJob.count({ where: { status: "queued" } });
      assert.equal(remaining, 0, "全部 queued 应被领走");
    });
  });

  it("已被领取（active）的 job 不会再次被领取", async () => {
    await withRollback(async (tx) => {
      await seedJobs(tx, 1);

      const claimed = await claimNextJob("worker-a", tx);
      assert.ok(claimed);
      // 另一个 worker 此时领取应得到 null（唯一的 job 已是 active）。
      const again = await claimNextJob("worker-b", tx);
      assert.equal(again, null);
    });
  });

  it("同一文档已有 queued/active extract 时不会重复入队", async () => {
    await withRollback(async (tx) => {
      const batch = await tx.batch.create({ data: { name: "dedupe-test" } });
      const doc = await tx.document.create({
        data: {
          batchId: batch.id,
          originalName: "dedupe.png",
          storedPath: "/tmp/dedupe.png",
          hash: `h-${batch.id}`,
          mimeType: "image/png",
          sizeBytes: 1,
        },
      });

      const first = await enqueueRecognitionJob(doc.id, batch.id, "extract", tx);
      const duplicateQueued = await enqueueRecognitionJob(doc.id, batch.id, "extract", tx);
      const claimed = await claimNextJob("worker-a", tx);
      const duplicateActive = await enqueueRecognitionJob(doc.id, batch.id, "extract", tx);

      assert.ok(first);
      assert.equal(duplicateQueued, null);
      assert.equal(claimed?.id, first.id);
      assert.equal(duplicateActive, null);
    });
  });
});
