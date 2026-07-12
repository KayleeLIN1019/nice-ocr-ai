import { PassThrough, Readable, type Writable } from "node:stream";
import ExcelJS from "exceljs";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import type { DbClient } from "@/lib/db/types";
import { getActiveScenarioId } from "@/lib/fields/active-scenario";
import {
  DEFAULT_EXPORT_TEMPLATE_ID,
  exportCellValue,
  extractPivotRows,
  getExportTemplate,
  renderWorkbook,
  resolveTemplateColumns,
  type ExportSourceRow,
  type ExportTemplate,
  type FlatExportTemplate,
} from "@/lib/workflows/export-templates";

export const xlsxContentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export type SearchMode = "fuzzy" | "exact";

/**
 * 选择性导出范围。字段语义与 rows 列表 API 的筛选完全一致（前后端同构），
 * 缺省（全部为空）= 全库（仅排除已删除行），保持既有行为兼容。
 * `rowIds` 为行级多选预留（下一期前端接入）。
 */
export interface ExportScope {
  batchId?: string;
  status?: string;
  /** 风险等级 → riskLevel */
  risk?: string;
  auditState?: string;
  /** 归一化月份 → normalizedMonth */
  month?: string;
  /** 商品编码/商品名综合搜索 */
  q?: string;
  /** 搜索模式：fuzzy=模糊包含，exact=完全相等；缺省保持模糊兼容旧行为。 */
  searchMode?: SearchMode;
  /** 商品编码 */
  code?: string;
  /** 商品名 */
  name?: string;
  /** 显式行 id 集合（行级多选）；存在时与其它条件取交集 */
  rowIds?: string[];
}

function textFilter(value: string, mode: SearchMode) {
  return mode === "exact" ? { equals: value } : { contains: value };
}

/** 把导出范围翻成 Prisma where（镜像 rows API 的筛选语义）。 */
export function scopeToWhere(scope?: ExportScope): Prisma.RecognitionRowWhereInput {
  const s = scope ?? {};
  const q = s.q?.trim();
  const code = s.code?.trim();
  const name = s.name?.trim();
  const searchMode = s.searchMode === "exact" ? "exact" : "fuzzy";
  return {
    deletedAt: null,
    ...(s.batchId ? { batchId: s.batchId } : {}),
    ...(s.status ? { status: s.status } : {}),
    ...(s.risk ? { riskLevel: s.risk } : {}),
    ...(s.auditState ? { auditState: s.auditState } : {}),
    ...(s.month ? { normalizedMonth: s.month } : {}),
    ...(q ? { OR: [{ code: textFilter(q, searchMode) }, { name: textFilter(q, searchMode) }] } : {}),
    ...(code ? { code: textFilter(code, searchMode) } : {}),
    ...(name ? { name: textFilter(name, searchMode) } : {}),
    ...(s.rowIds && s.rowIds.length ? { id: { in: s.rowIds } } : {}),
  };
}

/**
 * 按选定模板导出识别结果 xlsx（buffer 版，含自适应列宽 + pivot 多 sheet）。
 * 渲染由统一入口 `renderWorkbook` 按 kind 分派：flat=单表平铺，pivot=目录+单产品透视。
 * pivot 需全量行在内存分组，故走 buffer 而非流式。
 */
export async function buildRecognitionExport(
  templateId: string = DEFAULT_EXPORT_TEMPLATE_ID,
  scope?: ExportScope,
  db: DbClient = prisma,
) {
  const rows = await db.recognitionRow.findMany({
    where: scopeToWhere(scope),
    include: { document: true, batch: true },
    orderBy: [{ createdAt: "desc" }, { rowIndex: "asc" }],
  });
  const scenarioId = await getActiveScenarioId();
  const template = getExportTemplate(templateId);
  const source = rows as unknown as ExportSourceRow[];

  const workbook = new ExcelJS.Workbook();
  renderWorkbook(workbook, template, source, scenarioId);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

const EXPORT_PAGE_SIZE = 500;

/**
 * 流式导出识别结果：游标分页读库 + exceljs WorkbookWriter 逐行 commit，
 * 内存只驻留一页行 + 当前行，可导出超大数据集而不 OOM。
 * 与 buildRecognitionExport(buffer 版，自适应列宽，供测试/小量场景)不同，
 * 流式下列宽为静态(模板声明值)——自适应需回扫全部行，和流式不兼容。
 *
 * 返回 Web ReadableStream，路由直接 `new Response(stream)` 即可（Next 16 支持）。
 */
export function streamRecognitionExport(
  templateId: string = DEFAULT_EXPORT_TEMPLATE_ID,
  scope?: ExportScope,
  db: DbClient = prisma,
): { stream: ReadableStream<Uint8Array>; template: FlatExportTemplate } {
  const template = getExportTemplate(templateId);
  // 流式仅支持 flat 模板（pivot 需全量分组，走 buildRecognitionExport 的 buffer 版）。
  if (template.kind !== "flat") {
    throw new Error(
      `模板 ${template.id} 为 ${template.kind} 类型，不支持流式导出，请用 buildRecognitionExport`,
    );
  }
  const passthrough = new PassThrough();
  // 后台流式写入；任一环节出错则销毁流（客户端收到中断的下载，而非静默截断）。
  void writeStreamingWorkbook(passthrough, template, scope, db).catch((error) => {
    passthrough.destroy(error instanceof Error ? error : new Error(String(error)));
  });
  return { stream: Readable.toWeb(passthrough) as ReadableStream<Uint8Array>, template };
}

async function writeStreamingWorkbook(
  stream: Writable,
  template: FlatExportTemplate,
  scope: ExportScope | undefined,
  db: DbClient,
) {
  const scenarioId = await getActiveScenarioId();
  const columns = resolveTemplateColumns(template, scenarioId);

  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream,
    useStyles: true,
    useSharedStrings: true,
  });
  // 流式 WorksheetWriter 的 views 为只读 getter，冻结首行须经 addWorksheet 选项传入。
  const sheet = workbook.addWorksheet(template.sheetName, { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.columns = columns.map((field) => ({ header: field.label, key: field.key, width: field.width ?? 12 }));

  // 表头样式：流式下提交首行后不可改，必须在写数据行前设置并提交。
  const headerRow = sheet.getRow(1);
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2D3748" } };
    cell.alignment = { vertical: "middle", horizontal: "center" };
  });
  headerRow.commit();

  // 游标分页：每次只取一页，避免一次性把所有行装入内存。
  const where = scopeToWhere(scope);
  let cursor: string | undefined;
  for (;;) {
    const rows = await db.recognitionRow.findMany({
      where,
      include: { document: true, batch: true },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: EXPORT_PAGE_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (rows.length === 0) break;
    for (const row of rows) {
      const record: Record<string, string | number> = {};
      for (const field of columns)
        record[field.key] = exportCellValue(row as unknown as ExportSourceRow, field);
      const added = sheet.addRow(record);
      for (const field of columns) {
        if (field.numFmt) added.getCell(field.key).numFmt = field.numFmt;
        if (field.align === "right") added.getCell(field.key).alignment = { horizontal: "right" };
      }
      added.commit();
    }
    if (rows.length < EXPORT_PAGE_SIZE) break;
    cursor = rows[rows.length - 1].id;
  }

  await sheet.commit();
  await workbook.commit();
}

/**
 * 追加/合并导出：把作用域内的新数据并入一份已有的同模板 xlsx（上传基准，无状态）。
 * - pivot：反向解析基准 → 与新行合并 → 整表重渲染（自动并集产品/月份，评估列按合并后数据重算）。
 * - flat：复制基准工作簿，把新行续写到表尾（保留基准内容与样式）。
 * 结构不符（pivot 无产品 sheet / flat 无工作表）时抛错，不静默写坏。
 */
export async function appendRecognitionExport(
  templateId: string,
  scope: ExportScope | undefined,
  baseBuffer: Buffer,
  db: DbClient = prisma,
): Promise<{ buffer: Buffer; template: ExportTemplate; newRowCount: number }> {
  const template = getExportTemplate(templateId);
  const scenarioId = await getActiveScenarioId();
  const newRows = (await db.recognitionRow.findMany({
    where: scopeToWhere(scope),
    include: { document: true, batch: true },
    orderBy: [{ createdAt: "desc" }, { rowIndex: "asc" }],
  })) as unknown as ExportSourceRow[];

  const baseWorkbook = new ExcelJS.Workbook();
  // @types/node 的 Buffer 泛型与 exceljs 声明存在细微差异（ArrayBufferLike vs ArrayBuffer），经 unknown 转换。
  await baseWorkbook.xlsx.load(baseBuffer as unknown as Parameters<typeof baseWorkbook.xlsx.load>[0]);

  if (template.kind === "pivot") {
    const baseRows = extractPivotRows(baseWorkbook, template); // 结构非法时抛错
    const output = new ExcelJS.Workbook();
    renderWorkbook(output, template, [...baseRows, ...newRows], scenarioId);
    return { buffer: Buffer.from(await output.xlsx.writeBuffer()), template, newRowCount: newRows.length };
  }

  appendFlatRows(baseWorkbook, template, newRows, scenarioId);
  return {
    buffer: Buffer.from(await baseWorkbook.xlsx.writeBuffer()),
    template,
    newRowCount: newRows.length,
  };
}

/** 把新行按模板列顺序续写到 flat 基准工作簿的表尾。 */
function appendFlatRows(
  workbook: ExcelJS.Workbook,
  template: FlatExportTemplate,
  rows: ExportSourceRow[],
  scenarioId: string | null,
) {
  const columns = resolveTemplateColumns(template, scenarioId);
  const sheet = workbook.getWorksheet(template.sheetName) ?? workbook.worksheets[0];
  if (!sheet) throw new Error("上传的基准文件不含可追加的工作表");
  for (const row of rows) {
    const added = sheet.addRow(columns.map((field) => exportCellValue(row, field)));
    columns.forEach((field, index) => {
      if (field.numFmt) added.getCell(index + 1).numFmt = field.numFmt;
      if (field.align === "right") added.getCell(index + 1).alignment = { horizontal: "right" };
    });
  }
}

/** 记录一次导出历史（best-effort，失败不影响导出本身）。 */
export async function recordExportHistory(
  templateId: string,
  scope: ExportScope | undefined,
  rowCount: number,
  mode: "new" | "append",
  db: DbClient = prisma,
) {
  try {
    await db.exportRecord.create({
      data: {
        batchId: scope?.batchId ?? null,
        type: templateId,
        filterJson: JSON.stringify({ scope: scope ?? {}, mode }),
        filePath: "",
        rowCount,
      },
    });
  } catch {
    // 历史记录是审计增强，写失败不应阻断导出。
  }
}

export async function buildProductExport(db: DbClient = prisma) {
  const products = await db.product.findMany({
    include: { conflicts: true },
    orderBy: { updatedAt: "desc" },
  });

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("副食品资料库");
  sheet.columns = [
    { header: "商品编号", key: "code", width: 14 },
    { header: "商品名", key: "name", width: 20 },
    { header: "单位", key: "unit", width: 8 },
    { header: "别名", key: "aliases", width: 20 },
    { header: "是否冲突", key: "conflict", width: 10 },
    { header: "冲突原因", key: "conflictReason", width: 30 },
    { header: "备注", key: "remark", width: 20 },
  ];

  for (const product of products) {
    sheet.addRow({
      code: product.code ?? "",
      name: product.name,
      unit: product.unit ?? "",
      aliases: JSON.parse(product.aliasesJson).join("、"),
      conflict: product.conflicts.some((conflict) => conflict.status === "open") ? "是" : "否",
      conflictReason: product.conflicts.map((conflict) => conflict.reason).join("；"),
      remark: product.remark ?? "",
    });
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}
