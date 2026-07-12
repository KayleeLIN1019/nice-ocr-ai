import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { replaceProductNamesByCode } from "@/lib/workflows/rows";
import { scheduleProductLibraryRebuild } from "@/lib/workflows/products";
import { badRequest, handleRoute, parseJson } from "@/lib/api/http";

export const runtime = "nodejs";

const replaceProductNameSchema = z.object({
  code: z.string().min(1),
  toName: z.string().min(1),
  rowIds: z.array(z.string()).optional(),
  batchId: z.string().optional(),
  status: z.string().optional(),
  risk: z.string().optional(),
  auditState: z.string().optional(),
});

/** 按同一商品编码批量统一商品名，供「同编码不同产品」人工修复。 */
export async function POST(request: Request) {
  return handleRoute(async () => {
    const body = await parseJson(request, replaceProductNameSchema);
    const result = await prisma.$transaction((tx) => replaceProductNamesByCode(body, tx));

    if (result === null) throw badRequest("Provide code and toName");
    if (result.updated > 0) scheduleProductLibraryRebuild(1_000);
    return NextResponse.json(result);
  });
}
