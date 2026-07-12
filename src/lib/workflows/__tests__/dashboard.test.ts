import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { buildDashboardSummary } from "../dashboard";

const rollback = Symbol("rollback");

async function withRollback<T>(callback: (tx: Prisma.TransactionClient) => Promise<T>) {
  try {
    await prisma.$transaction(async (tx) => {
      await callback(tx);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}

describe("dashboard summary", () => {
  it("scopes processing totals and status to a selected monthly batch", async () => {
    await withRollback(async (tx) => {
      const scopedBatch = await tx.batch.create({ data: { name: "2026-06 scoped" } });
      const outsideBatch = await tx.batch.create({ data: { name: "2026-07 outside" } });
      const monthlyBatch = await tx.monthlyBatch.create({
        data: {
          name: "2026-06 月结",
          month: "2026-06",
          items: { create: [{ batchId: scopedBatch.id }] },
        },
      });

      const scopedDocument = await tx.document.create({
        data: {
          batchId: scopedBatch.id,
          originalName: "scoped.jpg",
          storedPath: "",
          hash: "dashboard-scoped",
          mimeType: "image/jpeg",
          sizeBytes: 1,
          status: "failed",
          riskLevel: "high",
          riskReasonsJson: JSON.stringify(["AMOUNT_MISMATCH"]),
          reviewStartedAt: new Date("2026-06-01T00:00:00.000Z"),
          reviewCompletedAt: new Date("2026-06-01T00:05:00.000Z"),
        },
      });
      const outsideDocument = await tx.document.create({
        data: {
          batchId: outsideBatch.id,
          originalName: "outside.jpg",
          storedPath: "",
          hash: "dashboard-outside",
          mimeType: "image/jpeg",
          sizeBytes: 1,
          status: "failed",
          riskLevel: "high",
        },
      });

      await tx.recognitionJob.create({
        data: { batchId: scopedBatch.id, documentId: scopedDocument.id, status: "queued" },
      });
      await tx.recognitionJob.create({
        data: { batchId: outsideBatch.id, documentId: outsideDocument.id, status: "queued" },
      });

      const autoRow = await tx.recognitionRow.create({
        data: {
          batchId: scopedBatch.id,
          documentId: scopedDocument.id,
          rowIndex: 1,
          name: "苹果",
          status: "confirmed",
          reviewClass: "ai_auto",
        },
      });
      await tx.recognitionRow.create({
        data: {
          batchId: scopedBatch.id,
          documentId: scopedDocument.id,
          rowIndex: 2,
          name: "梨",
          status: "confirmed",
          reviewClass: "human",
        },
      });
      const pendingRow = await tx.recognitionRow.create({
        data: {
          batchId: scopedBatch.id,
          documentId: scopedDocument.id,
          rowIndex: 3,
          name: "香蕉",
          status: "needs_review",
          auditState: "flagged",
        },
      });
      const outsideRow = await tx.recognitionRow.create({
        data: {
          batchId: outsideBatch.id,
          documentId: outsideDocument.id,
          rowIndex: 1,
          name: "橙子",
          status: "confirmed",
          reviewClass: "ai_auto",
        },
      });

      await tx.productConflict.create({
        data: {
          type: "NAME_MULTI_CODE",
          severity: "high",
          reason: "同名多编码",
          sourceRowIdsJson: JSON.stringify([pendingRow.id, autoRow.id]),
          status: "open",
        },
      });
      await tx.productConflict.create({
        data: {
          type: "CODE_NAME_CONFLICT",
          severity: "high",
          reason: "同码多品名",
          sourceRowIdsJson: JSON.stringify([outsideRow.id]),
          status: "open",
        },
      });

      const summary = await buildDashboardSummary({ monthlyBatchId: monthlyBatch.id }, tx);

      assert.equal(summary.scope.type, "monthlyBatch");
      assert.equal(summary.metrics.documents, 1);
      assert.equal(summary.metrics.queued, 1);
      assert.equal(summary.metrics.failed, 1);
      assert.equal(summary.metrics.confirmedRows, 2);
      assert.equal(summary.metrics.pendingRows, 1);
      assert.equal(summary.metrics.conflicts, 1);
      assert.equal(summary.metrics.autoApprovedRows, 1);
      assert.equal(summary.metrics.humanConfirmedRows, 1);
      assert.equal(summary.metrics.flaggedRows, 1);
      assert.equal(summary.metrics.autoApprovalRate, 50);
      assert.equal(summary.reviewTiming.totalMs, 5 * 60 * 1000);
      assert.equal(summary.reviewTiming.count, 1);
      assert.equal(summary.activeBatch?.id, scopedBatch.id);
      assert.deepEqual(
        summary.recentFailures.map((doc) => doc.id),
        [scopedDocument.id],
      );
      assert.deepEqual(summary.topRisks, [
        { type: "NAME_MULTI_CODE", reason: "同名多编码", severity: "high", count: 2 },
      ]);
    });
  });
});
