/**
 * 字段 Schema 单一事实源（前后端同构，纯配置，无副作用）。
 *
 * 统一驱动：AI 识别提取 → 入库 → 表格展示/编辑 → Excel 导出。
 * 把识别字段从写死的「副食品」场景解耦，新增字段/场景以扩展本注册表为主。
 *
 * - 识别字段（RECOGNITION_FIELD_CATALOG）：每行被识别/可编辑的字段。
 *   core=true 映射到 RecognitionRow 真实列；core=false 存入 RecognitionRow.extraJson。
 * - 元字段（META_FIELD_CATALOG）：派生/只读字段（批次/文档/月份/状态/风险），供表格上下文与导出引用，不参与识别。
 */

export type FieldType = "text" | "number" | "month" | "date";

export interface FieldDef {
  /** 稳定键：核心字段对应 RecognitionRow 列名；非核心字段为 extraJson 的键 */
  key: string;
  /** 展示标签（表头 / Excel 列头） */
  label: string;
  type: FieldType;
  /** true=映射真实列；false=存入 extraJson */
  core: boolean;
  /** 是否在明细表中渲染为可编辑输入框 */
  editable: boolean;
  /** 注入识别提示词的字段说明 */
  recognitionHint?: string;
  /** Excel 数字格式，如 "#,##0.00" */
  numFmt?: string;
  /** Excel 列宽 */
  width?: number;
  align?: "left" | "right";
}

/** RecognitionRow 上真实存在的核心识别列（用于区分 core / extra） */
export const CORE_ROW_COLUMNS = [
  "code",
  "name",
  "unit",
  "qty",
  "price",
  "amount",
  "remark",
  "rawDate",
  "normalizedMonth",
] as const;

export type CoreRowColumn = (typeof CORE_ROW_COLUMNS)[number];

/** 识别字段目录：场景从中引用核心字段；非核心字段由场景的 extraFields 定义 */
export const RECOGNITION_FIELD_CATALOG: Record<string, FieldDef> = {
  code: { key: "code", label: "商品编码", type: "text", core: true, editable: true, width: 14, recognitionHint: "商品编码/货号，没有则留空" },
  name: { key: "name", label: "商品名称", type: "text", core: true, editable: true, width: 20, recognitionHint: "商品名称" },
  unit: { key: "unit", label: "单位", type: "text", core: true, editable: true, width: 8, recognitionHint: "计量单位，如 件/箱/kg" },
  qty: { key: "qty", label: "数量", type: "number", core: true, editable: true, width: 10, numFmt: "#,##0.##", align: "right", recognitionHint: "数量，纯数字" },
  price: { key: "price", label: "单价", type: "number", core: true, editable: true, width: 10, numFmt: "#,##0.00", align: "right", recognitionHint: "单价，纯数字" },
  amount: { key: "amount", label: "金额", type: "number", core: true, editable: true, width: 12, numFmt: "#,##0.00", align: "right", recognitionHint: "金额，纯数字" },
  remark: { key: "remark", label: "备注", type: "text", core: true, editable: true, width: 20, recognitionHint: "备注，没有则留空" },
};

/** 元字段目录：派生/只读，供表格与导出引用 */
export const META_FIELD_CATALOG: Record<string, FieldDef> = {
  batch: { key: "batch", label: "批次", type: "text", core: true, editable: false, width: 20 },
  document: { key: "document", label: "图片名", type: "text", core: true, editable: false, width: 24 },
  rawDate: { key: "rawDate", label: "原始日期", type: "text", core: true, editable: false, width: 14 },
  normalizedMonth: { key: "normalizedMonth", label: "月份", type: "month", core: true, editable: false, width: 12 },
  status: { key: "status", label: "状态", type: "text", core: true, editable: false, width: 10 },
  riskLevel: { key: "riskLevel", label: "风险", type: "text", core: true, editable: false, width: 10 },
};

export interface FieldScenario {
  id: string;
  name: string;
  description: string;
  /** 该场景识别/管理的字段键（有序），引用识别目录或场景自带 extra 字段 */
  fieldKeys: string[];
  /** 场景自带的非核心字段定义（core 强制为 false，存入 extraJson） */
  extraFields?: FieldDef[];
}

export const DEFAULT_SCENARIO_ID = "grocery";

/**
 * 内置场景注册表。新增场景 = 在此追加一项；带新字段时在 extraFields 声明（core:false）。
 * 示例（未来）：在 extraFields 增加 { key: "spec", label: "规格", ... } 即可让识别/表格/导出全链路出现该字段。
 */
export const SCENARIOS: Record<string, FieldScenario> = {
  grocery: {
    id: "grocery",
    name: "副食品销售单/采购单",
    description: "默认场景：副食品单据明细行（编码/名称/单位/数量/单价/金额/备注）。",
    fieldKeys: ["code", "name", "unit", "qty", "price", "amount", "remark"],
  },
};

export function listScenarios(): Array<Pick<FieldScenario, "id" | "name" | "description">> {
  return Object.values(SCENARIOS).map(({ id, name, description }) => ({ id, name, description }));
}

export function getScenario(id: string | null | undefined): FieldScenario {
  return (id && SCENARIOS[id]) || SCENARIOS[DEFAULT_SCENARIO_ID];
}

function normalizeExtra(def: FieldDef): FieldDef {
  return { ...def, core: false };
}

/** 解析场景的有序识别字段定义（核心字段从目录取，extra 字段从场景取，缺失回退为文本字段） */
export function getScenarioFields(id: string | null | undefined): FieldDef[] {
  const scenario = getScenario(id);
  const extra = new Map((scenario.extraFields ?? []).map((f) => [f.key, normalizeExtra(f)]));
  return scenario.fieldKeys.map(
    (key) =>
      RECOGNITION_FIELD_CATALOG[key] ??
      extra.get(key) ??
      ({ key, label: key, type: "text", core: false, editable: true } satisfies FieldDef),
  );
}

/** 元字段定义列表（固定顺序），供表格与导出引用 */
export function getMetaFields(): FieldDef[] {
  return Object.values(META_FIELD_CATALOG);
}

/** 跨场景公共核心识别列（所有场景共有），用于混场景「全部」视图退化展示。 */
export const COMMON_CORE_FIELD_KEYS = ["code", "name", "unit", "qty", "price", "amount", "remark"] as const;

/** 公共核心识别字段定义（有序）：混场景结果表退化为这组安全交集列。 */
export function getCommonCoreFields(): FieldDef[] {
  return COMMON_CORE_FIELD_KEYS.map((key) => RECOGNITION_FIELD_CATALOG[key]);
}

/** 归一一组（可能为空/未知）场景 id 为去重的有效场景 id（无效回退默认场景），保持稳定顺序。 */
export function distinctScenarioIds(ids: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    const normalized = id && SCENARIOS[id] ? id : DEFAULT_SCENARIO_ID;
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}

/** 合并查找任意字段定义（识别字段 + 元字段 + 场景 extra） */
export function findFieldDef(id: string | null | undefined, key: string): FieldDef | undefined {
  return (
    RECOGNITION_FIELD_CATALOG[key] ??
    META_FIELD_CATALOG[key] ??
    getScenarioFields(id).find((f) => f.key === key)
  );
}

/** 判断字段是否为 RecognitionRow 真实列（否则属于 extraJson） */
export function isCoreColumn(key: string): key is CoreRowColumn {
  return (CORE_ROW_COLUMNS as readonly string[]).includes(key);
}

/**
 * 明细表里字段输入框/单元格的最小宽度类（屏幕展示用，独立于导出 Excel 的 width）。
 * 商品名称、备注等文本列给足宽度，保证长名称一眼可见、不被相邻列遮挡或截断。
 * compact=true 时收窄商品名称列（审核台用），让「状态/标识类别」在首屏内可见。
 */
export function fieldCellWidthClass(field: FieldDef, compact = false): string {
  if (field.key === "name") return compact ? "min-w-[11rem]" : "min-w-[18rem]";
  if (field.key === "remark") return "min-w-[12rem]";
  return "min-w-16";
}
