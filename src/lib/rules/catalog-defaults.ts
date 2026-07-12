/**
 * 规则字典「默认定义」——全系统稳定真源。
 *
 * 把分散在 validation/conflicts/audit/模型异常 里的英文码集中到一处：
 * - 产生侧（validateRow / detectProductConflictReasons / auditRowByRules / 识别 worker）只 push 这里的 `code`；
 * - 展示侧（审核台 / 冲突页 / 风险抽屉）全部经字典翻成中文释义；
 * - DB 表 RuleCatalog 是这份默认的可编辑副本：首次访问惰性补齐，运营改了不被覆盖，可一键重置为默认。
 *
 * 新增一条规则 = 在这里加一项默认 + 在对应产生侧 push 该 code，前后端自动跟随，无需改 UI。
 */

/** 规则分类：决定后台分组与默认严重度语义。 */
export type RuleCategory = "validation" | "conflict" | "audit" | "model_error";

export const RULE_CATEGORY_LABELS: Record<RuleCategory, string> = {
  validation: "行校验",
  conflict: "产品库冲突",
  audit: "二次审核",
  model_error: "模型/接口异常",
};

/** 严重度——与 RiskLevel 对齐，driving badge 配色。 */
export type RuleSeverity = "low" | "medium" | "high";

export interface RuleDefinition {
  code: string;
  category: RuleCategory;
  /** 中文名（badge 主文案） */
  label: string;
  /** 说明：这条原因意味着什么、为什么会触发 */
  description: string;
  /** 处理建议：审核人该怎么做 */
  suggestion: string;
  severity: RuleSeverity;
}

/** 行校验码：validateRow() 产生。 */
export type ValidationReasonCode = "INVALID_PRODUCT_NAME" | "AMOUNT_MISMATCH" | "CODE_CLEANED_BY_RULE";
/** 产品库冲突码：detectProductConflictReasons() / ProductConflict.type 产生。 */
export type ConflictReasonCode =
  | "INVALID_PRODUCT_NAME"
  | "CODE_CLEANED_BY_RULE"
  | "CODE_NAME_CONFLICT"
  | "NAME_MULTI_CODE"
  | "NAME_MULTI_UNIT";
/** 二次审核码：auditRowByRules() 产生。 */
export type AuditReasonCode = "RULE_VIOLATION" | "PRICE_OUTLIER" | "UNIT_MISMATCH" | "DUPLICATE_ROW";
/** 模型/接口异常码：classifyModelError() 归一化得到。 */
export type ModelErrorCode =
  | "MODEL_TIMEOUT"
  | "MODEL_RATE_LIMITED"
  | "MODEL_AUTH_ERROR"
  | "MODEL_QUOTA_EXCEEDED"
  | "MODEL_PARSE_ERROR"
  | "MODEL_NETWORK_ERROR"
  | "MODEL_UNKNOWN_ERROR";

export type ReasonCode = ValidationReasonCode | ConflictReasonCode | AuditReasonCode | ModelErrorCode;

/**
 * 默认字典。顺序即后台/列表内的展示顺序（sortOrder 取数组下标）。
 */
export const RULE_CATALOG_DEFAULTS: RuleDefinition[] = [
  // —— 行校验 ——
  {
    code: "INVALID_PRODUCT_NAME",
    category: "validation",
    label: "疑似非商品名",
    description: "该名称命中非商品名词库（如合计/备注/单位/数量），或为纯数字/符号，可能是表头或汇总行被误识别成了商品。",
    suggestion: "核对原图：若不是真实商品请删除该行；若是商品则修正名称后再确认。",
    severity: "high",
  },
  {
    code: "AMOUNT_MISMATCH",
    category: "validation",
    label: "金额不平",
    description: "数量 × 单价 与 识别金额 不一致（超过容差 0.01），三者中至少有一个识别有误。",
    suggestion: "对照原图核对数量、单价、金额，修正识别错误的一项。",
    severity: "medium",
  },
  {
    code: "CODE_CLEANED_BY_RULE",
    category: "validation",
    label: "编码被规则清洗",
    description: "识别到的编码疑似为行号/序号（4–5 位纯数字），已按规则清空以免污染产品库。",
    suggestion: "如确为真实商品编码，请手动填回正确编码。",
    severity: "low",
  },
  // —— 产品库冲突 ——
  {
    code: "CODE_NAME_CONFLICT",
    category: "conflict",
    label: "同编码多名称",
    description: "同一编码在不同记录里对应了多个商品名，可能是编码录错或商品名不统一。",
    suggestion: "统一该编码对应的标准商品名，或拆分被错填的编码。",
    severity: "high",
  },
  {
    code: "NAME_MULTI_CODE",
    category: "conflict",
    label: "同名称多编码",
    description: "同一商品名出现了多个编码，可能是别名/多规格，或编码录入不一致。",
    suggestion: "确认是否为同一商品：是则合并编码，否则按规格区分命名。",
    severity: "medium",
  },
  {
    code: "NAME_MULTI_UNIT",
    category: "conflict",
    label: "同名称多单位",
    description: "同一商品名出现了多个计量单位（如 kg/箱），可能是单位识别有误或规格不同。",
    suggestion: "统一单位口径，或按规格拆分商品名。",
    severity: "medium",
  },
  // —— 二次审核 ——
  {
    code: "RULE_VIOLATION",
    category: "audit",
    label: "规则校验未通过",
    description: "二次审核重跑行校验时仍存在未通过项（如非商品名 / 金额不平）。",
    suggestion: "回到该行按提示修正后重新确认。",
    severity: "medium",
  },
  {
    code: "PRICE_OUTLIER",
    category: "audit",
    label: "单价离群",
    description: "该单价显著偏离同一商品的历史中位数（默认高于 3 倍或低于 1/3）。",
    suggestion: "核对单价是否识别错位（小数点/千分位），或确属促销/批发价。",
    severity: "medium",
  },
  {
    code: "UNIT_MISMATCH",
    category: "audit",
    label: "单位与历史不符",
    description: "该单位与同一商品历史主导单位不一致。",
    suggestion: "确认本次单位是否识别有误，或确属不同规格。",
    severity: "medium",
  },
  {
    code: "DUPLICATE_ROW",
    category: "audit",
    label: "疑似重复行",
    description: "文档内存在「编码/名称 + 数量 + 单价 + 金额」完全一致的重复行。",
    suggestion: "核对是否重复录入，确认后删除多余行。",
    severity: "low",
  },
  // —— 模型/接口异常 ——
  {
    code: "MODEL_TIMEOUT",
    category: "model_error",
    label: "模型响应超时",
    description: "调用识别模型超过等待时间仍未返回结果。",
    suggestion: "稍后重试；多次超时可在设置中改用更快的模型或缩小图片尺寸。",
    severity: "medium",
  },
  {
    code: "MODEL_RATE_LIMITED",
    category: "model_error",
    label: "触发限流",
    description: "模型服务商返回限流（429 / Too Many Requests）。",
    suggestion: "降低队列并发或稍后重试；必要时提升服务商配额。",
    severity: "medium",
  },
  {
    code: "MODEL_AUTH_ERROR",
    category: "model_error",
    label: "鉴权失败",
    description: "API Key 无效或权限不足（401 / 403）。",
    suggestion: "到设置页检查该服务商的 API Key 与访问权限。",
    severity: "high",
  },
  {
    code: "MODEL_QUOTA_EXCEEDED",
    category: "model_error",
    label: "额度不足",
    description: "服务商返回额度耗尽 / 欠费相关错误。",
    suggestion: "检查账户余额或配额后重试。",
    severity: "high",
  },
  {
    code: "MODEL_PARSE_ERROR",
    category: "model_error",
    label: "输出解析失败",
    description: "模型返回的内容无法解析为约定的结构化结果。",
    suggestion: "重试；若持续失败，可在设置中调整提示词或更换模型。",
    severity: "medium",
  },
  {
    code: "MODEL_NETWORK_ERROR",
    category: "model_error",
    label: "网络异常",
    description: "连接模型服务时网络中断或地址不可达。",
    suggestion: "检查网络 / 代理与服务商 baseUrl 配置后重试。",
    severity: "medium",
  },
  {
    code: "MODEL_UNKNOWN_ERROR",
    category: "model_error",
    label: "未知模型错误",
    description: "识别调用失败，但未能匹配到已知错误类型。",
    suggestion: "展开下方原始错误信息排查，或联系管理员。",
    severity: "medium",
  },
];

/** 默认字典按 code 索引，供产生侧/兜底使用（不经过 DB）。 */
export const RULE_CATALOG_DEFAULTS_BY_CODE: Record<string, RuleDefinition> = Object.fromEntries(
  RULE_CATALOG_DEFAULTS.map((rule) => [rule.code, rule]),
);

/**
 * 把模型/接口返回的原始错误字符串归一化为稳定的 ModelErrorCode。
 * 纯函数、无 IO，便于在前后端复用与单测。匹配不到时回落 MODEL_UNKNOWN_ERROR。
 */
export function classifyModelError(raw?: string | null): ModelErrorCode {
  const text = String(raw ?? "").toLowerCase();
  if (!text.trim()) return "MODEL_UNKNOWN_ERROR";
  if (/(time?d?\s?out|timeout|etimedout|deadline)/.test(text)) return "MODEL_TIMEOUT";
  if (/(429|rate.?limit|too many requests|tps|qps limit)/.test(text)) return "MODEL_RATE_LIMITED";
  if (/(401|403|unauthorized|invalid api key|invalid_api_key|permission|forbidden|authentication)/.test(text))
    return "MODEL_AUTH_ERROR";
  if (/(quota|insufficient|billing|balance|欠费|余额|payment)/.test(text)) return "MODEL_QUOTA_EXCEEDED";
  if (/(parse|json|schema|unexpected token|zod|validation failed|invalid response|malformed)/.test(text))
    return "MODEL_PARSE_ERROR";
  if (/(econn|network|fetch failed|enotfound|socket|dns|unreachable|connection (refused|reset))/.test(text))
    return "MODEL_NETWORK_ERROR";
  return "MODEL_UNKNOWN_ERROR";
}
