import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { confirmRecognitionRows } from "@/lib/workflows/rows";
import { scheduleProductLibraryRebuild } from "@/lib/workflows/products";
import { badRequest, handleRoute, parseJson } from "@/lib/api/http";

export const runtime = "nodejs";

const bulkConfirmSchema = z.object({
  rowIds: z.array(z.string()).optional(),
  documentId: z.string().optional(),
  batchId: z.string().optional(),
  onlyLowRisk: z.boolean().optional(),
});

/**
 * 批量确认识别行。支持三种选择方式（按优先级）：
 *   1. rowIds[]    — 精确确认所选行（逐行确认 / 多选确认）。
 *   2. documentId  — 确认整单全部行（审核台「确认本单所有行」）。
 *   3. batchId     — 按批次确认，默认仅低风险（onlyLowRisk）。
 * 三者都缺失时返回 400，避免空选择误确认全部数据。
 */
export async function POST(request: Request) {
  return handleRoute(async () => {
    const body = await parseJson(request, bulkConfirmSchema);
    // 确认 + 同步把已 flagged 行置 reviewed 放进一个事务，保证两次 updateMany 原子生效。
    const updated = await prisma.$transaction((tx) =>
      confirmRecognitionRows(
        {
          rowIds: body.rowIds,
          documentId: body.documentId,
          batchId: body.batchId,
          onlyLowRisk: body.onlyLowRisk,
        },
        tx,
      ),
    );

    if (updated === null) throw badRequest("Provide rowIds[], documentId or batchId");
    // 新确认数据进入产品库基线 → 异步刷新产品库，保证后续联想/校验最新（不阻塞本次响应）。
    if (updated > 0) scheduleProductLibraryRebuild();
    return NextResponse.json({ updated });
  });
}
