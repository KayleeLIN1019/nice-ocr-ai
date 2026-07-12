import type ExcelJS from "exceljs";
import { getMetaFields, getScenarioFields, isCoreColumn, type FieldDef } from "@/lib/fields/field-schema";

/**
 * 导出模板注册表 + 共享渲染/样式引擎。
 *
 * 模板分两种形态（kind）：
 * - `flat`：单 sheet 平铺（列由 field-schema 解析）。`v5-20260618` 为 v5 原版导出的**精确复刻**，默认模板。
 * - `pivot`：多 sheet 透视（目录 + 每产品一页，按月份透视数量）。`purchase-stats-20260619` 复刻
 *   `docs/v5_new_3 2/副食品采购统计表` 的布局，评估单价/金额由系统计算。
 *
 * 统一入口 `renderWorkbook(workbook, template, rows, scenarioId)` 按 kind 分派；
 * 新增模板 = 往 EXPORT_TEMPLATES 追加一项（必要时加一种 kind 的渲染策略），**不改调用方**。
 */

/** 导出时一行的数据来源（核心列在行上，extra 字段在 extraJson，元字段在关联对象/派生）。 */
export interface ExportSourceRow {
  batch: { name: string };
  document: { originalName: string; tag?: string | null };
  rawDate?: string | null;
  normalizedMonth?: string | null;
  code?: string | null;
  name: string;
  unit?: string | null;
  qty: number;
  price: number;
  amount: number;
  remark?: string | null;
  extraJson?: string | null;
  status: string;
  riskLevel: string;
  conflictState?: string | null;
  riskReasonsJson?: string | null;
}

export type ExportTemplateKind = "flat" | "pivot";

interface ExportTemplateBase {
  id: string;
  name: string;
  description: string;
  filename: string;
  kind: ExportTemplateKind;
  /** 该模板期望的抽取场景；null=沿用批次/全局活动场景。用于"批次绑定模板即带出场景"。 */
  scenarioId?: string | null;
}

/** 单 sheet 平铺模板：列由活动场景字段 + 元字段经模板解析。 */
export interface FlatExportTemplate extends ExportTemplateBase {
  kind: "flat";
  sheetName: string;
  /** 解析该模板的有序列（基于活动场景识别字段 + 元字段）。 */
  resolveColumns: (scenarioFields: FieldDef[], metaFields: FieldDef[]) => FieldDef[];
}

/** 多 sheet 透视模板配置（采购统计表布局：目录 + 单产品 × 月份透视）。 */
export interface PivotTemplateConfig {
  /** 索引页 sheet 名 */
  tocSheetName: string;
  tocSeqLabel: string;
  tocNameLabel: string;
  /** 每栏（一组 序号/产品名）容纳的产品行数；超出后向右新增一栏。栏数随数据量增长。 */
  tocRowsPerColumn: number;
  /** 单产品 sheet 标题后缀，如「采购统计表」 */
  titleSuffix: string;
  seqLabel: string;
  unitLabel: string;
  assessUnitPriceLabel: string;
  assessAmountLabel: string;
  remarkLabel: string;
}

/** 多 sheet 透视模板。 */
export interface PivotExportTemplate extends ExportTemplateBase {
  kind: "pivot";
  pivot: PivotTemplateConfig;
}

export type ExportTemplate = FlatExportTemplate | PivotExportTemplate;

/** v5 状态值为中文；nice-ocr 内部为英文枚举，导出时映射回中文以与 v5 输出一致。 */
const STATUS_LABELS: Record<string, string> = {
  confirmed: "已确认",
  pending: "待确认",
  conflict: "冲突",
  excluded: "已排除",
  needs_review: "待复核",
};

/** v5 标准导出的 14 列（精确复刻：键/标签/宽度/数字格式/顺序）。 */
const V5_STANDARD_COLUMNS: FieldDef[] = [
  { key: "document", label: "图片名", type: "text", core: true, editable: false, width: 20 },
  { key: "tag", label: "图片标签", type: "text", core: true, editable: false, width: 12 },
  { key: "rawDate", label: "原始日期", type: "text", core: true, editable: false, width: 14 },
  { key: "normalizedMonth", label: "归一化月份", type: "text", core: true, editable: false, width: 14 },
  { key: "code", label: "商品编码", type: "text", core: true, editable: false, width: 14 },
  { key: "name", label: "商品名", type: "text", core: true, editable: false, width: 20 },
  { key: "unit", label: "单位", type: "text", core: true, editable: false, width: 8 },
  { key: "qty", label: "数量", type: "number", core: true, editable: false, width: 10, numFmt: "#,##0.##", align: "right" },
  { key: "price", label: "单价", type: "number", core: true, editable: false, width: 10, numFmt: "#,##0.00", align: "right" },
  { key: "amount", label: "金额", type: "number", core: true, editable: false, width: 12, numFmt: "#,##0.00", align: "right" },
  { key: "status", label: "状态", type: "text", core: true, editable: false, width: 10 },
  { key: "remark", label: "备注", type: "text", core: true, editable: false, width: 20 },
  { key: "libraryConflict", label: "资料库冲突", type: "text", core: true, editable: false, width: 12 },
  { key: "libraryConflictReason", label: "冲突原因", type: "text", core: true, editable: false, width: 24 },
];

export const EXPORT_TEMPLATES: ExportTemplate[] = [
  {
    id: "v5-20260618",
    name: "recognition result",
    description: "v5 原版导出（2026-06-18）：14 列，与原工具完全一致。默认模板。",
    filename: "recognition_result.xlsx",
    kind: "flat",
    scenarioId: "grocery",
    sheetName: "识别结果",
    resolveColumns: () => V5_STANDARD_COLUMNS,
  },
  {
    id: "purchase-stats-20260619",
    name: "副食品采购统计表",
    description: "副食品采购统计表（2026-06-19）：目录索引 + 每产品一页，按月份透视数量，自动计算评估单价/金额。",
    filename: "purchase_stats.xlsx",
    kind: "pivot",
    scenarioId: "grocery",
    pivot: {
      tocSheetName: "目录",
      tocSeqLabel: "序号",
      tocNameLabel: "产品名",
      tocRowsPerColumn: 200,
      titleSuffix: "采购统计表",
      seqLabel: "序号",
      unitLabel: "单位",
      assessUnitPriceLabel: "评估单价",
      assessAmountLabel: "评估金额",
      remarkLabel: "备注",
    },
  },
];

export const DEFAULT_EXPORT_TEMPLATE_ID = "v5-20260618";

export function getExportTemplate(id: string | null | undefined): ExportTemplate {
  return EXPORT_TEMPLATES.find((template) => template.id === id) ?? EXPORT_TEMPLATES[0];
}

export function listExportTemplates() {
  return EXPORT_TEMPLATES.map(({ id, name, description, kind }) => ({ id, name, description, kind }));
}

/** 解析 flat 模板在当前场景下的列定义（pivot 模板无列概念，返回空数组）。 */
export function resolveTemplateColumns(template: ExportTemplate, scenarioId: string | null): FieldDef[] {
  if (template.kind !== "flat") return [];
  return template.resolveColumns(getScenarioFields(scenarioId), getMetaFields());
}

/** 统一渲染入口：按 kind 把若干行渲染进工作簿。 */
export function renderWorkbook(
  workbook: ExcelJS.Workbook,
  template: ExportTemplate,
  rows: ExportSourceRow[],
  scenarioId: string | null,
) {
  if (template.kind === "pivot") {
    writePivotWorkbook(workbook, template, rows);
    return;
  }
  const columns = resolveTemplateColumns(template, scenarioId);
  writeTemplateSheet(workbook, template.sheetName, columns, rows);
}

/** 取某字段在一行上的导出值：元字段读关联/派生，核心列读列，extra 字段读 extraJson。 */
export function exportCellValue(row: ExportSourceRow, field: FieldDef): string | number {
  switch (field.key) {
    case "batch":
      return row.batch?.name ?? "";
    case "document":
      return row.document?.originalName ?? "";
    case "tag":
      return row.document?.tag ?? "";
    case "status":
      return STATUS_LABELS[row.status] ?? row.status ?? "";
    case "riskLevel":
      return row.riskLevel ?? "";
    case "rawDate":
      return row.rawDate ?? "";
    case "normalizedMonth":
      return row.normalizedMonth ?? "";
    case "libraryConflict":
      return row.conflictState === "open" ? "是" : "";
    case "libraryConflictReason":
      return joinReasons(row.riskReasonsJson);
    default:
      break;
  }
  if (isCoreColumn(field.key)) {
    const value = (row as unknown as Record<string, unknown>)[field.key];
    if (field.type === "number") return Number(value) || 0;
    return value == null ? "" : String(value);
  }
  const extra = safeParseObject(row.extraJson);
  const raw = extra[field.key];
  if (field.type === "number") return Number(raw) || 0;
  return raw == null ? "" : String(raw);
}

function joinReasons(raw?: string | null): string {
  if (!raw) return "";
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.join("；") : "";
  } catch {
    return "";
  }
}

function safeParseObject(raw?: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const cjkWidth = (text: string) =>
  [...text].reduce((sum, char) => sum + (/[一-龥]/.test(char) ? 2 : 1), 0);

const HEADER_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2D3748" } } as const;
const HEADER_FONT = { bold: true, color: { argb: "FFFFFFFF" } } as const;
const HEADER_ALIGN = { vertical: "middle", horizontal: "center" } as const;

/**
 * 把若干行写入一个工作表并套用 v5 风格样式：
 * 深色表头、按字段 numFmt 设数字格式、CJK 感知自适应列宽（上限 40）、冻结首行。
 */
export function writeTemplateSheet(
  workbook: ExcelJS.Workbook,
  sheetName: string,
  columns: FieldDef[],
  rows: ExportSourceRow[],
) {
  const sheet = workbook.addWorksheet(sheetName);
  sheet.columns = columns.map((field) => ({ header: field.label, key: field.key, width: field.width ?? 12 }));

  sheet.getRow(1).eachCell((cell) => {
    cell.font = { ...HEADER_FONT };
    cell.fill = { ...HEADER_FILL };
    cell.alignment = { ...HEADER_ALIGN };
  });

  for (const row of rows) {
    const record: Record<string, string | number> = {};
    for (const field of columns) record[field.key] = exportCellValue(row, field);
    const added = sheet.addRow(record);
    for (const field of columns) {
      if (field.numFmt) added.getCell(field.key).numFmt = field.numFmt;
      if (field.align === "right") added.getCell(field.key).alignment = { horizontal: "right" };
    }
  }

  // CJK 感知自适应列宽
  sheet.columns.forEach((col) => {
    let max = col.header ? cjkWidth(String(col.header)) : 10;
    col.eachCell?.({ includeEmpty: false }, (cell) => {
      const len = cjkWidth(String(cell.value ?? ""));
      if (len > max) max = len;
    });
    col.width = Math.min(max + 2, 40);
  });

  sheet.views = [{ state: "frozen", ySplit: 1 }];
  return sheet;
}

// ── 透视模板（采购统计表布局） ──────────────────────────────────────────────

interface PivotProduct {
  /** 1-based 序号（= 在目录中的顺位） */
  index: number;
  code: string;
  name: string;
  /** 分组键 = 编码+名称（与 sheet 名/目录产品名一致） */
  key: string;
  sheetName: string;
  rows: ExportSourceRow[];
}

/** 月份排序权重：「2020年1月」→ 2020*12+1，便于降序。无法解析返回 -1。 */
function monthRank(month: string): number {
  const match = /(\d{4})年(\d{1,2})月/.exec(month);
  return match ? Number(match[1]) * 12 + Number(match[2]) : -1;
}

/** Excel sheet 名安全化：去非法字符 `: \ / ? * [ ]`、截断 31 字符、去重、非空。 */
function safeSheetName(raw: string, used: Set<string>): string {
  const base = (raw.replace(/[:\\/?*[\]]/g, "_").slice(0, 31).trim() || "Sheet");
  let name = base;
  let n = 2;
  while (used.has(name)) {
    const suffix = `_${n++}`;
    name = base.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(name);
  return name;
}

/** 按 编码+名称 分组（保留首次出现顺序）并安全化 sheet 名。 */
function groupPivotProducts(rows: ExportSourceRow[], tocSheetName: string): PivotProduct[] {
  const order: string[] = [];
  const groups = new Map<string, ExportSourceRow[]>();
  for (const row of rows) {
    const code = (row.code ?? "").trim();
    const name = (row.name ?? "").trim();
    const key = `${code}${name}` || "未命名";
    let bucket = groups.get(key);
    if (!bucket) {
      bucket = [];
      groups.set(key, bucket);
      order.push(key);
    }
    bucket.push(row);
  }
  const used = new Set<string>([tocSheetName]);
  return order.map((key, i) => {
    const bucket = groups.get(key)!;
    const code = (bucket[0].code ?? "").trim();
    const name = (bucket[0].name ?? "").trim();
    return {
      index: i + 1,
      code,
      name,
      key,
      sheetName: safeSheetName(key || name || `产品${i + 1}`, used),
      rows: bucket,
    };
  });
}

function styleHeaderCell(cell: ExcelJS.Cell) {
  cell.font = { ...HEADER_FONT };
  cell.fill = { ...HEADER_FILL };
  cell.alignment = { ...HEADER_ALIGN };
}

function sheetHyperlink(sheetName: string) {
  return `#'${sheetName.replace(/'/g, "''")}'!A1`;
}

/** 写「目录」索引页：序号/产品名 成对，列优先纵向填充，每栏满 tocRowsPerColumn 后向右新增一栏。 */
function writeTocSheet(workbook: ExcelJS.Workbook, cfg: PivotTemplateConfig, products: PivotProduct[]) {
  const sheet = workbook.addWorksheet(cfg.tocSheetName);
  const rowsPerColumn = Math.max(1, cfg.tocRowsPerColumn);
  const columnGroups = Math.max(1, Math.ceil(products.length / rowsPerColumn));

  const headerRow = sheet.getRow(1);
  for (let g = 0; g < columnGroups; g++) {
    headerRow.getCell(g * 2 + 1).value = cfg.tocSeqLabel;
    headerRow.getCell(g * 2 + 2).value = cfg.tocNameLabel;
  }
  headerRow.eachCell(styleHeaderCell);

  products.forEach((product, i) => {
    const g = Math.floor(i / rowsPerColumn);
    const r = i % rowsPerColumn;
    const row = sheet.getRow(r + 2);
    row.getCell(g * 2 + 1).value = product.index;
    const nameCell = row.getCell(g * 2 + 2);
    nameCell.value = { text: product.key, hyperlink: sheetHyperlink(product.sheetName) };
    nameCell.font = { color: { argb: "FF0563C1" }, underline: true };
  });

  for (let g = 0; g < columnGroups; g++) {
    sheet.getColumn(g * 2 + 1).width = 8;
    sheet.getColumn(g * 2 + 2).width = 22;
  }
  sheet.views = [{ state: "frozen", ySplit: 1 }];
}

/** 写单产品 sheet：合并标题 + 表头 + 按月份透视数量 + 首行评估单价/金额。 */
function writeProductSheet(workbook: ExcelJS.Workbook, cfg: PivotTemplateConfig, product: PivotProduct) {
  const sheet = workbook.addWorksheet(product.sheetName);

  // 月份列 = 该产品出现的归一化月份，降序
  const monthSet = new Set<string>();
  for (const row of product.rows) {
    const month = (row.normalizedMonth ?? "").trim();
    if (month) monthSet.add(month);
  }
  const months = [...monthSet].sort((a, b) => monthRank(b) - monthRank(a));

  const headers = [cfg.seqLabel, cfg.unitLabel, ...months, cfg.assessUnitPriceLabel, cfg.assessAmountLabel, cfg.remarkLabel];
  const totalCols = headers.length;
  const monthColStart = 3;
  const assessUnitCol = 2 + months.length + 1;
  const assessAmountCol = assessUnitCol + 1;
  const remarkCol = assessAmountCol + 1;

  // R1 合并标题
  const titleCell = sheet.getRow(1).getCell(1);
  titleCell.value = `${product.name}${cfg.titleSuffix}`;
  sheet.mergeCells(1, 1, 1, totalCols);
  titleCell.font = { bold: true };
  titleCell.alignment = { vertical: "middle", horizontal: "center" };

  // R2 表头
  const headerRow = sheet.getRow(2);
  headers.forEach((label, idx) => {
    headerRow.getCell(idx + 1).value = label;
  });
  headerRow.eachCell(styleHeaderCell);

  // 评估值（决策2，系统计算）：评估单价=price>0 行均值；评估金额=评估单价×Σqty
  const positivePrices = product.rows.map((r) => Number(r.price) || 0).filter((p) => p > 0);
  const totalQty = product.rows.reduce((sum, r) => sum + (Number(r.qty) || 0), 0);
  const assessUnitPrice = positivePrices.length
    ? positivePrices.reduce((a, b) => a + b, 0) / positivePrices.length
    : 0;
  const assessAmount = assessUnitPrice * totalQty;

  product.rows.forEach((row, ri) => {
    const dataRow = sheet.getRow(3 + ri);
    dataRow.getCell(1).value = product.index;
    dataRow.getCell(2).value = (row.unit ?? "") || "";
    const month = (row.normalizedMonth ?? "").trim();
    const mIdx = months.indexOf(month);
    if (mIdx >= 0) {
      const cell = dataRow.getCell(monthColStart + mIdx);
      cell.value = Number(row.qty) || 0;
      cell.numFmt = "#,##0.##";
    }
    if (ri === 0) {
      const unitPriceCell = dataRow.getCell(assessUnitCol);
      unitPriceCell.value = assessUnitPrice;
      unitPriceCell.numFmt = "#,##0.00";
      const amountCell = dataRow.getCell(assessAmountCol);
      amountCell.value = assessAmount;
      amountCell.numFmt = "#,##0.00";
    }
    const remark = (row.remark ?? "") || "";
    if (remark) dataRow.getCell(remarkCol).value = remark;
  });

  headers.forEach((label, idx) => {
    sheet.getColumn(idx + 1).width = Math.min(Math.max(cjkWidth(label) + 2, 8), 20);
  });
  // 冻结标题 + 表头两行
  sheet.views = [{ state: "frozen", ySplit: 2 }];
}

/** 透视工作簿：目录 + 每产品一页。需全量行在内存分组（不走流式）。 */
export function writePivotWorkbook(
  workbook: ExcelJS.Workbook,
  template: PivotExportTemplate,
  rows: ExportSourceRow[],
) {
  const cfg = template.pivot;
  const products = groupPivotProducts(rows, cfg.tocSheetName);
  writeTocSheet(workbook, cfg, products);
  for (const product of products) writeProductSheet(workbook, cfg, product);
}

// ── 透视模板反向解析（追加/合并：读已有 xlsx → 还原成行 → 与新数据重渲染） ──────

function cellText(value: ExcelJS.CellValue): string {
  if (value == null) return "";
  if (typeof value === "object") {
    if ("richText" in value && Array.isArray(value.richText)) return value.richText.map((t) => t.text).join("");
    if ("text" in value && value.text != null) return String(value.text);
    if ("result" in value && value.result != null) return String(value.result);
    return "";
  }
  return String(value);
}

function cellNumber(value: ExcelJS.CellValue): number | null {
  if (typeof value === "number") return value;
  if (value && typeof value === "object" && "result" in value && typeof value.result === "number") return value.result;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

const MONTH_HEADER = /^\d{4}年\d{1,2}月$/;

/** 构造一个仅含透视所需字段的来源行（其余必填字段用占位，渲染器不读）。 */
function pivotSourceRow(code: string, name: string, unit: string, qty: number, month: string, remark: string): ExportSourceRow {
  return {
    batch: { name: "" },
    document: { originalName: "" },
    normalizedMonth: month,
    code,
    name,
    unit,
    qty,
    price: 0,
    amount: 0,
    remark,
    status: "",
    riskLevel: "",
  };
}

/**
 * 把一个已有的「采购统计表」工作簿反向解析回行列表（用于追加/合并后整表重算重渲染）。
 * 旧记录的数量/月份/产品/单位完整保留；单价不在透视表中存储，故还原为 0（评估列由重渲染按新数据重算）。
 * 结构非法（无任何可识别的产品 sheet）时抛错，避免把不匹配的文件静默写坏。
 */
export function extractPivotRows(workbook: ExcelJS.Workbook, template: PivotExportTemplate): ExportSourceRow[] {
  const cfg = template.pivot;
  const suffix = cfg.titleSuffix;
  const rows: ExportSourceRow[] = [];
  let recognized = 0;

  for (const sheet of workbook.worksheets) {
    if (sheet.name === cfg.tocSheetName) continue;
    // 表头行（R2）：col1=序号、col2=单位，其后为动态月份列，再后为评估列与备注。
    const header = sheet.getRow(2);
    if (cellText(header.getCell(1).value) !== cfg.seqLabel || cellText(header.getCell(2).value) !== cfg.unitLabel) {
      continue; // 不是产品 sheet，跳过
    }
    recognized += 1;

    const monthCols: Array<{ col: number; label: string }> = [];
    let remarkCol = 0;
    header.eachCell((cell, col) => {
      const text = cellText(cell.value);
      if (MONTH_HEADER.test(text)) monthCols.push({ col, label: text });
      else if (text === cfg.remarkLabel) remarkCol = col;
    });

    const title = cellText(sheet.getRow(1).getCell(1).value);
    const name = title.endsWith(suffix) ? title.slice(0, title.length - suffix.length) : sheet.name;
    const code = sheet.name.endsWith(name) ? sheet.name.slice(0, sheet.name.length - name.length) : "";

    for (let r = 3; r <= sheet.rowCount; r++) {
      const dataRow = sheet.getRow(r);
      const unit = cellText(dataRow.getCell(2).value);
      const remark = remarkCol ? cellText(dataRow.getCell(remarkCol).value) : "";
      for (const month of monthCols) {
        const qty = cellNumber(dataRow.getCell(month.col).value);
        if (qty != null) rows.push(pivotSourceRow(code, name, unit, qty, month.label, remark));
      }
    }
  }

  if (recognized === 0) {
    throw new Error(`上传的文件不是有效的「${template.name}」（未找到任何产品工作表），无法追加`);
  }
  return rows;
}
