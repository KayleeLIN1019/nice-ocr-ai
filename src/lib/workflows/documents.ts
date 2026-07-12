/**
 * 文档审核态聚合（纯函数，无副作用）。
 *
 * 把「按 (documentId, status) 分组的行计数」收敛为每文档的 rowStats 与派生 reviewState，
 * 供批次详情、跨批次审核待办列表共用同一套口径，避免两处算法漂移。
 */

export type DocumentReviewState = "pending" | "partial" | "confirmed" | "conflict";

export interface DocumentRowStats {
  total: number;
  confirmed: number;
  conflict: number;
}

export function emptyRowStats(): DocumentRowStats {
  return { total: 0, confirmed: 0, conflict: 0 };
}

/** 由行级统计派生文档审核态：有冲突→冲突；全部确认→已确认；部分确认→部分；否则待复核。 */
export function computeReviewState(stat: DocumentRowStats): DocumentReviewState {
  if (stat.conflict > 0) return "conflict";
  if (stat.total > 0 && stat.confirmed === stat.total) return "confirmed";
  if (stat.confirmed > 0) return "partial";
  return "pending";
}

/** Prisma groupBy(documentId,status) 结果 → 每文档 rowStats 映射。 */
export function rowStatsByDocument(
  grouped: Array<{ documentId: string; status: string; _count: { _all: number } }>,
): Map<string, DocumentRowStats> {
  const map = new Map<string, DocumentRowStats>();
  for (const entry of grouped) {
    const stat = map.get(entry.documentId) ?? emptyRowStats();
    const count = entry._count._all;
    stat.total += count;
    if (entry.status === "confirmed") stat.confirmed += count;
    if (entry.status === "conflict") stat.conflict += count;
    map.set(entry.documentId, stat);
  }
  return map;
}
