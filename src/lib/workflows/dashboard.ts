import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/lib/db/client";

const QUEUE_STATUSES = ["queued", "active", "retrying"];
const PENDING_ROW_STATUSES = ["pending", "needs_review", "conflict"];
const REVIEW_CAP_MS = 10 * 60 * 1000;

type DashboardDb = Pick<
  PrismaClient | Prisma.TransactionClient,
  "monthlyBatch" | "document" | "recognitionJob" | "recognitionRow" | "productConflict" | "batch"
>;

export class DashboardScopeNotFoundError extends Error {
  constructor() {
    super("Monthly batch not found");
  }
}

function parseReasons(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export async function buildDashboardSummary(
  options: { monthlyBatchId?: string | null } = {},
  db: DashboardDb = defaultPrisma,
) {
  const monthlyBatchId = options.monthlyBatchId?.trim();
  const monthlyBatch = monthlyBatchId
    ? await db.monthlyBatch.findUnique({
        where: { id: monthlyBatchId },
        include: {
          items: {
            orderBy: { createdAt: "asc" },
            include: {
              batch: {
                select: {
                  id: true,
                  name: true,
                  status: true,
                  createdAt: true,
                  _count: { select: { documents: true, rows: true } },
                },
              },
            },
          },
        },
      })
    : null;

  if (monthlyBatchId && !monthlyBatch) throw new DashboardScopeNotFoundError();

  const scopedBatchIds = monthlyBatch ? monthlyBatch.items.map((item) => item.batchId) : null;
  const batchIdFilter = scopedBatchIds ? { in: scopedBatchIds } : undefined;
  const documentScope: Prisma.DocumentWhereInput = batchIdFilter ? { batchId: batchIdFilter } : {};
  const rowScope: Prisma.RecognitionRowWhereInput = batchIdFilter ? { batchId: batchIdFilter } : {};
  const jobScope: Prisma.RecognitionJobWhereInput = batchIdFilter ? { batchId: batchIdFilter } : {};
  const batchScope: Prisma.BatchWhereInput = scopedBatchIds ? { id: { in: scopedBatchIds } } : {};

  const [
    documents,
    queued,
    failed,
    pendingRows,
    confirmedRows,
    autoApprovedRows,
    humanConfirmedRows,
    flaggedRows,
    activeBatch,
    recentFailures,
    openConflicts,
    reviewedDocs,
    scopedRowsForConflicts,
  ] = await Promise.all([
    db.document.count({ where: documentScope }),
    db.recognitionJob.count({ where: { ...jobScope, status: { in: QUEUE_STATUSES } } }),
    db.document.count({ where: { ...documentScope, status: "failed" } }),
    db.recognitionRow.count({
      where: { ...rowScope, deletedAt: null, status: { in: PENDING_ROW_STATUSES } },
    }),
    db.recognitionRow.count({ where: { ...rowScope, deletedAt: null, status: "confirmed" } }),
    db.recognitionRow.count({ where: { ...rowScope, deletedAt: null, reviewClass: "ai_auto" } }),
    db.recognitionRow.count({ where: { ...rowScope, deletedAt: null, reviewClass: "human" } }),
    db.recognitionRow.count({ where: { ...rowScope, deletedAt: null, auditState: "flagged" } }),
    db.batch.findFirst({
      where: batchScope,
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { documents: true, rows: true } } },
    }),
    db.document.findMany({
      where: { ...documentScope, OR: [{ status: "failed" }, { riskLevel: "high" }] },
      orderBy: { updatedAt: "desc" },
      take: 8,
    }),
    db.productConflict.findMany({
      where: { status: "open" },
      orderBy: [{ severity: "desc" }, { createdAt: "desc" }],
      include: { product: true },
    }),
    db.document.findMany({
      where: {
        ...documentScope,
        reviewStartedAt: { not: null },
        reviewCompletedAt: { not: null },
      },
      select: { reviewStartedAt: true, reviewCompletedAt: true },
    }),
    scopedBatchIds
      ? db.recognitionRow.findMany({
          where: { batchId: { in: scopedBatchIds }, deletedAt: null },
          select: { id: true },
        })
      : Promise.resolve([]),
  ]);

  const scopedRowIds = scopedBatchIds ? new Set(scopedRowsForConflicts.map((row) => row.id)) : null;
  const scopedOpenConflicts = scopedRowIds
    ? openConflicts.filter((conflict) =>
        parseReasons(conflict.sourceRowIdsJson).some((id) => scopedRowIds.has(id)),
      )
    : openConflicts;

  let totalReviewMs = 0;
  for (const doc of reviewedDocs) {
    if (doc.reviewStartedAt && doc.reviewCompletedAt) {
      const ms = doc.reviewCompletedAt.getTime() - doc.reviewStartedAt.getTime();
      if (ms > 0) totalReviewMs += Math.min(ms, REVIEW_CAP_MS);
    }
  }
  const reviewedDocCount = reviewedDocs.length;
  const avgReviewMs = reviewedDocCount > 0 ? Math.round(totalReviewMs / reviewedDocCount) : 0;

  const riskByType = new Map<string, { type: string; reason: string; severity: string; count: number }>();
  for (const conflict of scopedOpenConflicts) {
    const sourceIds = parseReasons(conflict.sourceRowIdsJson);
    const count = scopedRowIds
      ? sourceIds.filter((id) => scopedRowIds.has(id)).length
      : sourceIds.length || 1;
    if (count <= 0) continue;
    const entry = riskByType.get(conflict.type) ?? {
      type: conflict.type,
      reason: conflict.reason,
      severity: conflict.severity,
      count: 0,
    };
    entry.count += count;
    riskByType.set(conflict.type, entry);
  }

  const autoApprovalRate = confirmedRows > 0 ? Math.round((autoApprovedRows / confirmedRows) * 100) : 0;
  const monthBatches = monthlyBatch
    ? monthlyBatch.items.map((item) => ({
        id: item.batch.id,
        name: item.batch.name,
        status: item.batch.status,
        createdAt: item.batch.createdAt,
        documents: item.batch._count.documents,
        rows: item.batch._count.rows,
      }))
    : [];

  return {
    scope: monthlyBatch
      ? {
          type: "monthlyBatch" as const,
          id: monthlyBatch.id,
          name: monthlyBatch.name,
          month: monthlyBatch.month,
          notes: monthlyBatch.notes,
          batchCount: monthlyBatch.items.length,
          batches: monthBatches,
        }
      : { type: "all" as const, name: "全部批次" },
    metrics: {
      documents,
      queued,
      failed,
      pendingRows,
      confirmedRows,
      conflicts: scopedOpenConflicts.length,
      autoApprovedRows,
      humanConfirmedRows,
      autoApprovalRate,
      flaggedRows,
    },
    reviewTiming: { totalMs: totalReviewMs, avgMs: avgReviewMs, count: reviewedDocCount },
    activeBatch: activeBatch
      ? {
          id: activeBatch.id,
          name: activeBatch.name,
          status: activeBatch.status,
          documents: activeBatch._count.documents,
          rows: activeBatch._count.rows,
        }
      : null,
    recentFailures: recentFailures.map((doc) => ({
      id: doc.id,
      batchId: doc.batchId,
      fileName: doc.originalName,
      status: doc.status,
      risk: doc.riskLevel,
      reasons: parseReasons(doc.riskReasonsJson),
      reasonFallback: doc.status === "failed" ? "识别失败" : "需要人工复核",
      updatedAt: doc.updatedAt,
    })),
    topRisks: Array.from(riskByType.values()).slice(0, 6),
  };
}
