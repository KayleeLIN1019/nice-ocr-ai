import { cleanProductCode, validateRow } from "@/lib/validation/rules";

/**
 * 审核(二次复查)纯逻辑：对"机器自动通过(ai_auto)"行做规则/统计预筛，挑出可疑行。
 * 不含任何 IO / AI 调用，便于单测；worker 负责加载历史与第三次 AI 交叉验证。
 */

export type AuditReasonCode = "RULE_VIOLATION" | "PRICE_OUTLIER" | "UNIT_MISMATCH" | "DUPLICATE_ROW";

export interface AuditableRow {
  id?: string;
  code?: string | null;
  name: string;
  unit?: string | null;
  qty: number;
  price: number;
  amount: number;
}

export interface AuditOptions {
  /** 单价离群倍率：价 > 中位数×ratio 或 < 中位数/ratio 视为离群。默认 3。 */
  priceOutlierRatio?: number;
  /** 触发统计判断所需的最少历史样本。默认 3。 */
  minHistory?: number;
}

export interface AuditStat {
  prices: number[];
  units: string[];
}

/** 统计键：有规范编码按编码，否则按去空白商品名（与产品库重建/一致性比对一致）。 */
export function auditStatKey(code: string | null | undefined, name: string): string {
  const clean = cleanProductCode(code);
  return clean ? `code:${clean}` : `name:${normalizeName(name)}`;
}

/** 从历史确认行聚合每个商品的单价样本与单位样本（ProductObservation 不含单价，故取历史行）。 */
export function buildAuditStats(history: AuditableRow[]): Map<string, AuditStat> {
  const map = new Map<string, AuditStat>();
  for (const row of history) {
    const key = auditStatKey(row.code, row.name);
    const stat = map.get(key) ?? { prices: [], units: [] };
    if (Number(row.price) > 0) stat.prices.push(Number(row.price));
    if (row.unit && String(row.unit).trim()) stat.units.push(String(row.unit).trim());
    map.set(key, stat);
  }
  return map;
}

/** 规则/统计预筛单行：重跑校验 + 单价离群 + 单位与历史主导不一致。 */
export function auditRowByRules(
  row: AuditableRow,
  stats: Map<string, AuditStat>,
  options: AuditOptions = {},
): { suspicious: boolean; reasons: AuditReasonCode[] } {
  const ratio = options.priceOutlierRatio ?? 3;
  const minHistory = options.minHistory ?? 3;
  const reasons: AuditReasonCode[] = [];

  const validation = validateRow({
    code: row.code ?? "",
    name: row.name,
    qty: row.qty,
    price: row.price,
    amount: row.amount,
  });
  if (validation.reasons.length) reasons.push("RULE_VIOLATION");

  const stat = stats.get(auditStatKey(row.code, row.name));
  if (stat && stat.prices.length >= minHistory && Number(row.price) > 0) {
    const med = median(stat.prices);
    if (med > 0 && (row.price > med * ratio || row.price < med / ratio)) {
      reasons.push("PRICE_OUTLIER");
    }
  }
  if (stat && stat.units.length >= minHistory && row.unit) {
    const dominant = mode(stat.units);
    if (dominant.value && dominant.ratio >= 0.6 && String(row.unit).trim() !== dominant.value) {
      reasons.push("UNIT_MISMATCH");
    }
  }

  return { suspicious: reasons.length > 0, reasons };
}

/** 找出文档内完全重复的行（编码/名称 + 数量 + 单价 + 金额一致），返回涉及的行 id 集合。 */
export function findDuplicateRowIds(rows: AuditableRow[]): Set<string> {
  const seen = new Map<string, string>();
  const dups = new Set<string>();
  for (const row of rows) {
    if (!row.id) continue;
    const signature = `${auditStatKey(row.code, row.name)}|${row.qty}|${row.price}|${row.amount}`;
    const first = seen.get(signature);
    if (first) {
      dups.add(first);
      dups.add(row.id);
    } else {
      seen.set(signature, row.id);
    }
  }
  return dups;
}

function normalizeName(name: string): string {
  return String(name ?? "").replace(/\s+/g, "").trim();
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mode(values: string[]): { value: string | null; ratio: number } {
  if (!values.length) return { value: null, ratio: 0 };
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best: string | null = null;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return { value: best, ratio: bestCount / values.length };
}
