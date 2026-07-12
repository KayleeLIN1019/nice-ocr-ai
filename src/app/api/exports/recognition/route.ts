import { z } from "zod";
import { prisma } from "@/lib/db/client";
import {
  appendRecognitionExport,
  buildRecognitionExport,
  recordExportHistory,
  scopeToWhere,
  streamRecognitionExport,
  xlsxContentType,
  type ExportScope,
} from "@/lib/workflows/exports";
import { DEFAULT_EXPORT_TEMPLATE_ID, getExportTemplate } from "@/lib/workflows/export-templates";

export const runtime = "nodejs";
// 追加大表（反向解析 + 整表重渲染）可能耗时，放宽执行上限。
export const maxDuration = 300;

/** 选择性导出范围：字段语义与 rows 列表筛选一致；缺省=全库（兼容旧行为）。 */
const scopeSchema = z
  .object({
    batchId: z.string().optional(),
    status: z.string().optional(),
    risk: z.string().optional(),
    auditState: z.string().optional(),
    month: z.string().optional(),
    q: z.string().optional(),
    searchMode: z.enum(["fuzzy", "exact"]).optional(),
    code: z.string().optional(),
    name: z.string().optional(),
    rowIds: z.array(z.string()).optional(),
  })
  .optional();

const bodySchema = z
  .object({
    templateId: z.string().optional(),
    scope: scopeSchema,
    mode: z.enum(["new", "append", "merge"]).optional(),
  })
  .partial();

function xlsxResponse(body: BodyInit, filename: string) {
  return new Response(body, {
    headers: {
      "content-type": xlsxContentType,
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";

  // 追加/合并：multipart 上传已有 xlsx 作为基准 + meta(JSON)。
  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const baseFile = form.get("baseFile");
    if (!(baseFile instanceof File)) {
      return Response.json({ error: "缺少基准文件 baseFile" }, { status: 400 });
    }
    const meta = bodySchema.safeParse(safeJson(String(form.get("meta") ?? "{}")));
    const data = meta.success ? meta.data : {};
    const templateId = data.templateId ?? DEFAULT_EXPORT_TEMPLATE_ID;
    const scope = data.scope as ExportScope | undefined;
    const baseBuffer = Buffer.from(await baseFile.arrayBuffer());
    try {
      const { buffer, template, newRowCount } = await appendRecognitionExport(templateId, scope, baseBuffer);
      void recordExportHistory(template.id, scope, newRowCount, "append");
      return xlsxResponse(new Uint8Array(buffer), template.filename);
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "追加导出失败" },
        { status: 400 },
      );
    }
  }

  // 新建导出：JSON body。
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  const body = parsed.success ? parsed.data : {};
  const templateId = body.templateId ?? DEFAULT_EXPORT_TEMPLATE_ID;
  const scope = body.scope as ExportScope | undefined;
  const template = getExportTemplate(templateId);
  const rowCount = await prisma.recognitionRow.count({ where: scopeToWhere(scope) });

  // pivot 多 sheet 透视需全量分组，走 buffer 版；flat 走流式（游标分页，超大结果集不 OOM）。
  if (template.kind === "pivot") {
    const buffer = await buildRecognitionExport(template.id, scope);
    void recordExportHistory(template.id, scope, rowCount, "new");
    return xlsxResponse(new Uint8Array(buffer), template.filename);
  }

  const { stream, template: flat } = streamRecognitionExport(template.id, scope);
  void recordExportHistory(flat.id, scope, rowCount, "new");
  return xlsxResponse(stream, flat.filename);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
