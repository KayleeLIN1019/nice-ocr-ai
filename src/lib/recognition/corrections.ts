/**
 * 从历史人工修正中学习的「纠正记忆」（确定性规则，非模型训练）。
 *
 * 来源：AuditLog 里 RecognitionRow 的 update 记录，beforeJson/afterJson 是字段级 diff
 * （见 audit-log.ts）。思路：同一个「识别值 → 你改成的正确值」在文本字段上重复出现达到阈值，
 * 即固化成一条纠正，在识别落库前自动套用（与 applyBrandRules 同阶段）。
 *
 * 只学**名称/编码**这类 OCR 误识纠错；**不学单位**——单位是"件→斤"这种高频但与具体商品强相关的值，
 * 学成全局规则会把本就是"件"的商品全改错；单位改由产品库"产品名→单位"承担（更准）。
 * 也不学 qty/price/amount（单据具体数值，复用会改错别的单据）。
 * 另用 protectedBefore 兜底：错值本身若是合法商品名（在产品库里），绝不当作 OCR 错误替换，
 * 避免"香菜→净蒜""三文鱼→三文治"这类把正确行改错的误伤。纯逻辑、无 IO，便于单测。
 */

export type CorrectionField = "name" | "unit" | "code";
export const CORRECTION_FIELDS: CorrectionField[] = ["name", "code"];

export interface CorrectionObservation {
  field: CorrectionField;
  before: string;
  after: string;
}

export interface CorrectionOptions {
  /** 同一 before→after 至少出现多少次才固化，默认 2，避免一次性编辑被误固化。 */
  minOccurrences?: number;
  /** 主导占比阈值：同一 before 下该 after 需占多数，默认 0.6，规避相互矛盾的修正。 */
  dominanceRatio?: number;
  /** 受保护的归一化值集合：这些值是已知正确（如合法商品名），即使作为 before 出现也不固化为纠正。 */
  protectedBefore?: Set<string>;
}

/** 匹配键归一：NFKC（全角→半角）+ 小写 + 去空白，与 consensus 名称归一一致。 */
export function normalizeCorrectionKey(value: string): string {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, "")
    .trim();
}
const normalizeKey = normalizeCorrectionKey;

/** 从审计观测构建纠正表：field → (归一化 before → 固化 after)。 */
export function buildCorrectionMap(
  observations: CorrectionObservation[],
  options: CorrectionOptions = {},
): Map<CorrectionField, Map<string, string>> {
  const minOccurrences = options.minOccurrences ?? 2;
  const dominanceRatio = options.dominanceRatio ?? 0.6;

  // field → beforeKey → afterValue → count
  const tally = new Map<CorrectionField, Map<string, Map<string, number>>>();
  for (const obs of observations) {
    const before = String(obs.before ?? "").trim();
    const after = String(obs.after ?? "").trim();
    if (!before || !after) continue;
    if (normalizeKey(before) === normalizeKey(after)) continue; // 无实质变化
    const beforeKey = normalizeKey(before);
    if (!beforeKey) continue;
    if (options.protectedBefore?.has(beforeKey)) continue; // 错值本身是合法值 → 不当作 OCR 错误
    const byField = tally.get(obs.field) ?? new Map<string, Map<string, number>>();
    const byBefore = byField.get(beforeKey) ?? new Map<string, number>();
    byBefore.set(after, (byBefore.get(after) ?? 0) + 1);
    byField.set(beforeKey, byBefore);
    tally.set(obs.field, byField);
  }

  const result = new Map<CorrectionField, Map<string, string>>();
  for (const [field, byBefore] of tally) {
    const map = new Map<string, string>();
    for (const [beforeKey, afterCounts] of byBefore) {
      let total = 0;
      let best = "";
      let bestCount = 0;
      for (const [after, count] of afterCounts) {
        total += count;
        if (count > bestCount) {
          best = after;
          bestCount = count;
        }
      }
      if (bestCount >= minOccurrences && bestCount / total >= dominanceRatio) {
        map.set(beforeKey, best);
      }
    }
    if (map.size) result.set(field, map);
  }
  return result;
}

export interface CorrectableRow {
  code?: string | null;
  name?: string | null;
  unit?: string | null;
}

export interface CorrectionResult {
  code: string | null;
  name: string;
  unit: string | null;
  corrected: CorrectionField[];
}

/** 对一行套用纠正表，返回纠正后的文本字段（命中才改，否则原样）。 */
export function applyLearnedCorrections(
  row: CorrectableRow,
  map: Map<CorrectionField, Map<string, string>>,
): CorrectionResult {
  const corrected: CorrectionField[] = [];
  const fix = (field: CorrectionField, value: string | null | undefined): string | null => {
    const raw = value == null ? null : String(value);
    if (raw == null || raw.trim() === "") return raw;
    const hit = map.get(field)?.get(normalizeKey(raw));
    if (hit != null && hit !== raw) {
      corrected.push(field);
      return hit;
    }
    return raw;
  };
  return {
    code: fix("code", row.code),
    name: fix("name", row.name) ?? "",
    unit: fix("unit", row.unit),
    corrected,
  };
}

/** 从 AuditLog 的 before/after JSON 对象提取文本字段纠正观测（仅 name/unit/code）。 */
export function observationsFromAuditDiff(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): CorrectionObservation[] {
  if (!before || !after) return [];
  const out: CorrectionObservation[] = [];
  for (const field of CORRECTION_FIELDS) {
    if (field in before && field in after) {
      const b = before[field];
      const a = after[field];
      if (typeof b === "string" && typeof a === "string") {
        out.push({ field, before: b, after: a });
      }
    }
  }
  return out;
}
