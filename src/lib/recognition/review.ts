import { cleanProductCode } from "@/lib/validation/rules";

export type ApprovalMode = "manual" | "hybrid" | "auto";
export type RecognitionStrategy = "fast" | "balanced" | "consensus" | "manual";
export type ReviewClass = "ai_auto" | "human" | "pending_review" | "conflict";
export type RowStatus = "pending" | "confirmed" | "needs_review" | "conflict" | "excluded";
export type RiskLevel = "low" | "medium" | "high";

export interface ReviewDecision {
  status: RowStatus;
  reviewClass: ReviewClass;
}

export const approvalModes: ApprovalMode[] = ["manual", "hybrid", "auto"];

export function normalizeApprovalMode(value: string | null | undefined): ApprovalMode {
  return value === "manual" || value === "auto" ? value : "hybrid";
}

/** 该模式是否需要双次识别做一致性比对。 */
export function requiresConsensus(mode: ApprovalMode): boolean {
  return mode !== "manual";
}

export function shouldRunConsensus(
  strategy: RecognitionStrategy,
  mode: ApprovalMode,
  hasAutoCandidate: boolean,
): boolean {
  if (mode === "manual" || strategy === "manual" || strategy === "fast") return false;
  if (strategy === "consensus") return true;
  return hasAutoCandidate;
}

/**
 * 决定一行的最终状态与标识类别。
 * 规则：高风险（疑似非商品名等）任何模式都不自动通过；
 * manual 全部转人工；hybrid 需「双次一致 + 低风险」；auto 仅需「双次一致」（低/中风险均可）。
 * blockAuto（如数量为 0）为一票否决：任何模式都不允许自动通过，强制转人工。
 */
export function decideRowReview(
  mode: ApprovalMode,
  riskLevel: RiskLevel | string,
  consensusAgreed: boolean,
  blockAuto = false,
): ReviewDecision {
  if (riskLevel === "high") {
    return { status: "conflict", reviewClass: "conflict" };
  }
  if (mode === "manual") {
    return { status: riskLevel === "low" ? "pending" : "needs_review", reviewClass: "pending_review" };
  }
  // hybrid 需「低风险 + 双次一致」；auto 仅需「双次一致」（低/中风险均可）。
  const wouldAutoConfirm = mode === "hybrid" ? riskLevel === "low" && consensusAgreed : consensusAgreed;
  if (wouldAutoConfirm && !blockAuto) {
    return { status: "confirmed", reviewClass: "ai_auto" };
  }
  return { status: "needs_review", reviewClass: "pending_review" };
}

export interface ComparableRow {
  code?: string | null;
  name: string;
  qty: number;
  price: number;
  amount: number;
}

/**
 * 比对两次识别结果，返回 primary 中每一行是否在 secondary 中找到一致的对应行。
 * 匹配键：有规范编码时按编码，否则按去空白的商品名；数量/单价/金额须在容差内一致。
 */
export function buildConsensusFlags(
  primary: ComparableRow[],
  secondary: ComparableRow[],
  tolerance = 0.01,
): boolean[] {
  const used = new Array(secondary.length).fill(false);
  return primary.map((row) => {
    const matchIndex = secondary.findIndex(
      (other, index) =>
        !used[index] &&
        sameKey(row, other) &&
        near(row.qty, other.qty, tolerance) &&
        near(row.price, other.price, tolerance) &&
        near(row.amount, other.amount, tolerance),
    );
    if (matchIndex >= 0) {
      used[matchIndex] = true;
      return true;
    }
    return false;
  });
}

function sameKey(a: ComparableRow, b: ComparableRow): boolean {
  const codeA = cleanProductCode(a.code);
  const codeB = cleanProductCode(b.code);
  if (codeA && codeB) return codeA === codeB;
  return normalizeName(a.name) === normalizeName(b.name);
}

/**
 * 商品名归一化：NFKC（全角→半角、兼容字形）+ 小写 + 去空白。
 * 只做"真正等价"的归一，不做编辑距离/相似度匹配——consensus 会驱动自动通过，
 * 放宽匹配会把"苹果"和"苹果汁"等不同品名误判一致而错误自动通过。
 */
function normalizeName(name: string): string {
  return String(name ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, "")
    .trim();
}

function near(a: number, b: number, tolerance: number): boolean {
  return Math.abs(Number(a || 0) - Number(b || 0)) <= tolerance;
}
