/**
 * 产品库模糊匹配（纯逻辑，无 IO，可单测、可在前端运行）。
 *
 * 目标：把识别出的可疑商品名，去（随确认数据不断变大的）产品库里按"名称相似度 + 单价/单位吻合"
 * 打分，给出带置信度的候选名。供审核台作为一键建议小标——绝不自动改，由人确认。
 *
 * 安全设计：
 * - 名字若已是库内商品（完全一致）→ 视为正确，不给建议。
 * - 必须有足够的名称相似度（minNameSim）才作候选——单价吻合只能加分排序，不能单凭价相同就改名，
 *   避免"鸭爪→西瓜"这类靠巧合价格的误导。
 */

export interface MatchProduct {
  name: string;
  /** 预归一化的名称（调用方一次性算好，避免逐行重复归一）。 */
  norm: string;
  unit?: string | null;
  price?: number | null;
}

export interface MatchRow {
  name: string;
  unit?: string | null;
  price?: number | null;
}

export interface NameCandidate {
  name: string;
  /** 置信度 0-100。 */
  confidence: number;
}

export interface MatchOptions {
  /** 候选最低相似度（0-1），默认 0.5。 */
  minNameSim?: number;
  /** 候选最低综合得分（0-1），默认 0.6。 */
  minScore?: number;
  /** 最多返回几个候选，默认 2。 */
  max?: number;
}

/** 归一化：NFKC（全角→半角）+ 小写 + 去空白，与其它模块一致。 */
export function normalizeMatchKey(value: string | null | undefined): string {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, "")
    .trim();
}

/** 两个（已归一化）字符串的编辑距离。 */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const row = new Array<number>(n + 1);
  for (let j = 0; j <= n; j += 1) row[j] = j;
  for (let i = 1; i <= m; i += 1) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const cur = row[j];
      row[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, row[j], row[j - 1]);
      prev = cur;
    }
  }
  return row[n];
}

/** 相似度（0-1），输入需已归一化。 */
export function levSimilarity(a: string, b: string): number {
  if (a === b) return a.length ? 1 : 0;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 0;
  return 1 - editDistance(a, b) / maxLen;
}

/** 单价吻合度（0-1）：在容差内得 1，量级接近得 0.5，差太多得 0，无价信息中性 0.3。 */
function priceCorroboration(rowPrice: number | null | undefined, productPrice: number | null | undefined): number {
  if (!rowPrice || rowPrice <= 0 || !productPrice || productPrice <= 0) return 0.3;
  const ratio = rowPrice / productPrice;
  if (ratio >= 0.8 && ratio <= 1.25) return 1;
  if (ratio >= 0.5 && ratio <= 2) return 0.5;
  return 0;
}

/** 给一行在产品库里找带置信度的候选名（按综合得分降序）。 */
export function matchLibraryCandidates(
  row: MatchRow,
  library: MatchProduct[],
  options: MatchOptions = {},
): NameCandidate[] {
  const minNameSim = options.minNameSim ?? 0.5;
  const minScore = options.minScore ?? 0.6;
  const max = options.max ?? 2;

  const rowKey = normalizeMatchKey(row.name);
  if (rowKey.length < 2) return []; // 太短不可靠
  const rowUnit = normalizeMatchKey(row.unit);

  const best = new Map<string, number>(); // 产品名 → 最高得分
  for (const product of library) {
    if (!product.norm) continue;
    if (product.norm === rowKey) return []; // 名字已是库内商品 → 正确，不建议
    // 长度差预筛：编辑距离 ≥ 长度差，长度差过大相似度必然不达标，先跳过省去编辑距离计算。
    const maxLen = Math.max(rowKey.length, product.norm.length);
    if (Math.abs(rowKey.length - product.norm.length) > maxLen * (1 - minNameSim)) continue;

    const sim = levSimilarity(rowKey, product.norm);
    if (sim < minNameSim) continue;

    const priceScore = priceCorroboration(row.price, product.price);
    const unitScore = rowUnit && product.unit && rowUnit === normalizeMatchKey(product.unit) ? 1 : 0;
    const score = 0.7 * sim + 0.2 * priceScore + 0.1 * unitScore;
    if (score < minScore) continue;

    const prev = best.get(product.name) ?? 0;
    if (score > prev) best.set(product.name, score);
  }

  return [...best.entries()]
    .filter(([name]) => normalizeMatchKey(name) !== rowKey)
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([name, score]) => ({ name, confidence: Math.round(score * 100) }));
}
