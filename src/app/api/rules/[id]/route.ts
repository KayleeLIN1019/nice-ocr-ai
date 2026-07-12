import { NextResponse } from "next/server";
import { z } from "zod";
import { resetRuleCatalog, updateRuleCatalog } from "@/lib/rules/catalog";
import { handleRoute, notFound, parseJson } from "@/lib/api/http";

export const runtime = "nodejs";

const rulePatchSchema = z.object({
  label: z.string().trim().min(1).max(40).optional(),
  description: z.string().trim().max(400).optional(),
  suggestion: z.string().trim().max(400).optional(),
  severity: z.enum(["low", "medium", "high"]).optional(),
  enabled: z.boolean().optional(),
  /** reset=true 时忽略其余字段，整条重置为代码默认。 */
  reset: z.boolean().optional(),
});

/** 编辑一条规则的中文释义/严重度/启停，或整条重置为默认。 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const { id } = await params;
    const body = await parseJson(request, rulePatchSchema);
    const rule = body.reset
      ? await resetRuleCatalog(id)
      : await updateRuleCatalog(id, {
          label: body.label,
          description: body.description,
          suggestion: body.suggestion,
          severity: body.severity,
          enabled: body.enabled,
        });
    if (!rule) throw notFound("规则不存在或不可重置");
    return NextResponse.json({ rule });
  });
}
