import { isShortProductCode, validateRow } from "@/lib/validation/rules";

export type ReviewQueue = "manual" | "auto_pass" | "sample";
export type FieldIssueSeverity = "info" | "warning" | "danger";
export type FieldIssueAction = "clear_code" | "use_alt_name" | "use_candidate_name" | "use_candidate_code" | "use_candidate_unit";
export type ReviewField = "code" | "name" | "unit" | "qty" | "price" | "amount";

export interface ReviewFieldIssue {
  field: ReviewField;
  code: string;
  severity: FieldIssueSeverity;
  message: string;
  action?: FieldIssueAction;
  suggestion?: string;
}

export interface ReviewTriageRow {
  id: string;
  status: string;
  riskLevel: string;
  priority: "high" | "medium" | "low";
  queue: ReviewQueue;
  needsHuman: boolean;
  fieldIssues: ReviewFieldIssue[];
  reasons: string[];
}

export interface ReviewDocumentTriage {
  queue: ReviewQueue;
  autoPassEligible: boolean;
  blockers: string[];
  rowCounts: {
    total: number;
    confirmed: number;
    manual: number;
    autoPass: number;
    sample: number;
  };
}

export interface ReviewTriage {
  document: ReviewDocumentTriage;
  rows: ReviewTriageRow[];
}

export interface TriageRowInput {
  id: string;
  code?: string | null;
  name: string;
  unit?: string | null;
  qty: number;
  price: number;
  amount: number;
  status: string;
  reviewClass?: string | null;
  riskLevel: string;
  riskReasonsJson?: string | null;
  auditState?: string | null;
  auditNote?: string | null;
  auditSuggestionJson?: string | null;
  altName?: string | null;
}

function parseReasons(raw?: string | null): string[] {
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function issue(
  field: ReviewField,
  code: string,
  severity: FieldIssueSeverity,
  message: string,
  extra: Pick<ReviewFieldIssue, "action" | "suggestion"> = {},
): ReviewFieldIssue {
  return { field, code, severity, message, ...extra };
}

export function buildRowTriage(row: TriageRowInput): ReviewTriageRow {
  const validation = validateRow({
    code: row.code ?? "",
    name: row.name,
    qty: row.qty,
    price: row.price,
    amount: row.amount,
  });
  const storedReasons = parseReasons(row.riskReasonsJson);
  const reasons = unique([...storedReasons, ...validation.reasons]);
  const fieldIssues: ReviewFieldIssue[] = [];

  if (reasons.includes("INVALID_PRODUCT_NAME")) {
    fieldIssues.push(issue("name", "INVALID_PRODUCT_NAME", "danger", "商品名像表头、合计或无效文本"));
  }
  if (row.altName && row.altName.trim() && row.altName.trim() !== row.name.trim()) {
    fieldIssues.push(
      issue("name", "ALT_MODEL_NAME", "info", `副模型识别为：${row.altName.trim()}`, {
        action: "use_alt_name",
        suggestion: row.altName.trim(),
      }),
    );
  }
  if (reasons.includes("NAME_MULTI_CODE")) {
    fieldIssues.push(issue("code", "NAME_MULTI_CODE", "warning", "同一商品名存在多个编码"));
  }
  if (reasons.includes("CODE_NAME_CONFLICT")) {
    fieldIssues.push(issue("name", "CODE_NAME_CONFLICT", "danger", "同一编码对应多个商品名"));
  }
  if (isShortProductCode(row.code)) {
    fieldIssues.push(
      issue("code", "SHORT_PRODUCT_CODE", "warning", "商品编码少于 3 位，可能是行号误识别", {
        action: "clear_code",
        suggestion: "",
      }),
    );
  }
  if (reasons.includes("ZERO_QTY")) {
    fieldIssues.push(issue("qty", "ZERO_QTY", "danger", "数量为空或为 0"));
  }
  if (reasons.includes("AMOUNT_MISMATCH")) {
    fieldIssues.push(issue("amount", "AMOUNT_MISMATCH", "danger", "金额与数量 x 单价不一致"));
  }
  if (row.auditState === "flagged") {
    fieldIssues.push(issue("price", "AUDIT_FLAGGED", "danger", row.auditNote || "二次审核标记为可疑"));
  }

  const hasDanger = fieldIssues.some((item) => item.severity === "danger");
  const hasWarning = fieldIssues.some((item) => item.severity === "warning");
  const nonLowRisk = row.riskLevel !== "low";
  const needsHuman =
    row.status !== "confirmed" &&
    (hasDanger ||
      hasWarning ||
      nonLowRisk ||
      row.status === "conflict" ||
      row.status === "needs_review" ||
      row.auditState === "flagged");
  const queue: ReviewQueue = needsHuman ? "manual" : row.status === "confirmed" ? "sample" : "auto_pass";

  return {
    id: row.id,
    status: row.status,
    riskLevel: row.riskLevel,
    priority: hasDanger || row.riskLevel === "high" ? "high" : hasWarning || nonLowRisk ? "medium" : "low",
    queue,
    needsHuman,
    fieldIssues,
    reasons,
  };
}

export function buildDocumentTriage(rows: TriageRowInput[]): ReviewTriage {
  const rowTriage = rows.map(buildRowTriage);
  const blockers: string[] = [];
  const activeRows = rows.filter((row) => row.status !== "excluded");

  if (activeRows.length === 0) blockers.push("没有可确认的识别行");
  for (const row of rowTriage) {
    if (row.needsHuman) blockers.push(`第 ${rows.findIndex((item) => item.id === row.id) + 1} 行需要人工处理`);
  }

  const rowCounts = {
    total: activeRows.length,
    confirmed: activeRows.filter((row) => row.status === "confirmed").length,
    manual: rowTriage.filter((row) => row.queue === "manual").length,
    autoPass: rowTriage.filter((row) => row.queue === "auto_pass").length,
    sample: rowTriage.filter((row) => row.queue === "sample").length,
  };
  const autoPassEligible = rowCounts.total > 0 && rowCounts.manual === 0 && rowCounts.autoPass > 0;
  const queue: ReviewQueue = rowCounts.manual > 0 ? "manual" : autoPassEligible ? "auto_pass" : "sample";

  return {
    document: {
      queue,
      autoPassEligible,
      blockers: unique(blockers).slice(0, 8),
      rowCounts,
    },
    rows: rowTriage,
  };
}

export function rowIssueMap(triage: ReviewTriage): Map<string, ReviewTriageRow> {
  return new Map(triage.rows.map((row) => [row.id, row]));
}
