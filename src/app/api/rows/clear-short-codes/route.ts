import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { clearShortProductCodes } from "@/lib/workflows/rows";
import { badRequest, handleRoute, parseJson } from "@/lib/api/http";

export const runtime = "nodejs";

const clearShortCodesSchema = z.object({
  rowIds: z.array(z.string()).optional(),
  documentId: z.string().optional(),
});

/** 清空当前选择范围内少于 3 位的商品编码，供审核台按页批量处理。 */
export async function POST(request: Request) {
  return handleRoute(async () => {
    const body = await parseJson(request, clearShortCodesSchema);
    const result = await prisma.$transaction((tx) =>
      clearShortProductCodes(
        {
          rowIds: body.rowIds,
          documentId: body.documentId,
        },
        tx,
      ),
    );

    if (result === null) throw badRequest("Provide rowIds[] or documentId");
    return NextResponse.json(result);
  });
}
