import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { replaceProductCodesByName } from "@/lib/workflows/rows";
import { scheduleProductLibraryRebuild } from "@/lib/workflows/products";
import { badRequest, handleRoute, parseJson } from "@/lib/api/http";

export const runtime = "nodejs";

const replaceProductCodeSchema = z.object({
  name: z.string().min(1),
  toCode: z.string().min(1),
  rowIds: z.array(z.string()).optional(),
  batchId: z.string().optional(),
  status: z.string().optional(),
  risk: z.string().optional(),
  auditState: z.string().optional(),
});

/** 按同一商品名批量统一编码，供全部结果页处理「同名多编码」人工修复。 */
export async function POST(request: Request) {
  return handleRoute(async () => {
    const body = await parseJson(request, replaceProductCodeSchema);
    const result = await prisma.$transaction((tx) => replaceProductCodesByName(body, tx));

    if (result === null) throw badRequest("Provide name and toCode");
    if (result.updated > 0) scheduleProductLibraryRebuild(1_000);
    return NextResponse.json(result);
  });
}
