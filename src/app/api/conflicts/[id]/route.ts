import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveProductConflict } from "@/lib/workflows/conflicts";
import { handleRoute, notFound, parseJson } from "@/lib/api/http";

export const runtime = "nodejs";

const conflictPatchSchema = z.object({
  status: z.enum(["resolved", "ignored"]).optional(),
  note: z.string().nullish(),
});

/**
 * 处理产品库冲突：标记为已解决或忽略。
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const { id } = await params;
    const body = await parseJson(request, conflictPatchSchema);
    const conflict = await resolveProductConflict(id, { status: body.status, note: body.note });
    if (!conflict) throw notFound("Conflict not found");
    return NextResponse.json({ conflict });
  });
}
