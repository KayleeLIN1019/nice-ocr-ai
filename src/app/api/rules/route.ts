import { NextResponse } from "next/server";
import { listRuleCatalog } from "@/lib/rules/catalog";
import { RULE_CATEGORY_LABELS } from "@/lib/rules/catalog-defaults";
import { handleRoute } from "@/lib/api/http";

export const runtime = "nodejs";

/** 返回整本规则字典（首次访问惰性补齐默认项）。供审核台/冲突页展示与后台编辑共享。 */
export async function GET() {
  return handleRoute(async () => {
    const rules = await listRuleCatalog();
    return NextResponse.json({ rules, categoryLabels: RULE_CATEGORY_LABELS });
  });
}
