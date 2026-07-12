import { NextResponse } from "next/server";
import { listExportTemplates } from "@/lib/workflows/export-templates";

export const runtime = "nodejs";

/** 返回内置导出模板列表，供前端模板选择。 */
export async function GET() {
  return NextResponse.json({ templates: listExportTemplates() });
}
