import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { computeReviewState, emptyRowStats, rowStatsByDocument } from "@/lib/workflows/documents";
import { detectProductConflictReasons } from "@/lib/products/conflicts";

export const runtime = "nodejs";

/**
 * 跨批次文档列表（审核台「全部」待办流的数据通路）。
 *
 * - 无 `batchId` → 列出全部批次的文档；带 `batchId` → 收窄到单批次（隔离视图）。
 * - `search` 按文件名模糊过滤；每条返回所属批次名与派生 reviewState/rowStats。
 * - reviewState 由行级统计派生，故按 reviewState 的过滤在派生后进行。
 * - 文档量级与批次详情同口径（一次性返回 + 客户端分页/导航），无需服务端分页。
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const batchId = searchParams.get("batchId");
  const search = searchParams.get("search");
  const reviewState = searchParams.get("reviewState");

  const where = {
    ...(batchId ? { batchId } : {}),
    ...(search ? { originalName: { contains: search } } : {}),
  };

  const documents = await prisma.document.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: { batch: { select: { name: true } } },
  });

  const docIds = documents.map((document) => document.id);
  const grouped = docIds.length
    ? await prisma.recognitionRow.groupBy({
        by: ["documentId", "status"],
        where: { documentId: { in: docIds }, deletedAt: null },
        _count: { _all: true },
      })
    : [];
  const statMap = rowStatsByDocument(grouped);
  const rowsInDocs = docIds.length
    ? await prisma.recognitionRow.findMany({
        where: { documentId: { in: docIds }, deletedAt: null },
        select: { id: true, documentId: true, status: true, code: true, name: true, unit: true },
      })
    : [];
  const names = Array.from(new Set(rowsInDocs.map((row) => row.name).filter(Boolean)));
  const codes = Array.from(new Set(rowsInDocs.map((row) => row.code?.trim()).filter(Boolean) as string[]));
  const relatedRows = names.length || codes.length
    ? await prisma.recognitionRow.findMany({
        where: {
          deletedAt: null,
          OR: [
            ...(names.length ? [{ name: { in: names } }] : []),
            ...(codes.length ? [{ code: { in: codes } }] : []),
          ],
        },
        select: { id: true, code: true, name: true, unit: true },
      })
    : [];
  const productReasonMap = detectProductConflictReasons(relatedRows.map((row) => ({ rowId: row.id, code: row.code, name: row.name, unit: row.unit })));
  const productConflictCountByDoc = new Map<string, number>();
  for (const row of rowsInDocs) {
    if (row.status === "conflict") continue;
    const productReasons = productReasonMap.get(row.id) ?? [];
    if (!productReasons.includes("NAME_MULTI_CODE") && !productReasons.includes("CODE_NAME_CONFLICT")) continue;
    productConflictCountByDoc.set(row.documentId, (productConflictCountByDoc.get(row.documentId) ?? 0) + 1);
  }

  const items = documents
    .map((document) => {
      const baseStat = statMap.get(document.id) ?? emptyRowStats();
      const stat = {
        ...baseStat,
        conflict: baseStat.conflict + (productConflictCountByDoc.get(document.id) ?? 0),
      };
      return {
        id: document.id,
        originalName: document.originalName,
        batchId: document.batchId,
        batchName: document.batch.name,
        riskLevel: document.riskLevel,
        rowStats: stat,
        reviewState: computeReviewState(stat),
      };
    })
    .filter((item) => (reviewState ? item.reviewState === reviewState : true));

  return NextResponse.json({ documents: items, total: items.length });
}
