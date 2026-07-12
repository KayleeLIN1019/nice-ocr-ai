/**
 * 把识别行匹配到 OCR 版面文字行 → 行级原图来源区域（确定性纯函数，便于单测、可换 OCR 后端）。
 *
 * 思路：
 * 1. 把 OCR 文字行按垂直中心聚类成「行带」（一张票的一行可能被切成编码/名称/金额等多段文字）。
 * 2. 每个行带取成员文字框的并集为包围盒、按 x 排序拼出整行文本。
 * 3. 用商品编码（唯一数字串）精确子串匹配识别行 → 行带；编码缺失/未命中再按名称相似度兜底。
 * 4. 命中的行带转成 SourceRegion(source="layout_ocr")；未命中返回 undefined（worker 据此降级）。
 */

import type { OcrLayoutLine, OcrLayoutResult } from "@/lib/recognition/ocr-layout";
import type { SourceRegion, SourceRegionBox } from "@/lib/recognition/source-region";

export interface LayoutMatchRow {
  code?: string | null;
  name?: string | null;
}

interface RowBand {
  box: SourceRegionBox;
  text: string;
}

export interface MatchOptions {
  /** 行带聚类容差占中位行高的比例。 */
  clusterRatio?: number;
  /** 名称兜底匹配的最小相似度（字符 bigram Jaccard）。 */
  minNameSimilarity?: number;
  /** 参与编码匹配的最小编码长度，避免 1~2 位数字误命中。 */
  minCodeLength?: number;
}

const DEFAULTS: Required<MatchOptions> = {
  clusterRatio: 0.6,
  minNameSimilarity: 0.5,
  minCodeLength: 3,
};

/** 与 rows 等长：命中返回 SourceRegion，未命中返回 undefined。 */
export function matchRowsToLayout(
  rows: LayoutMatchRow[],
  layout: OcrLayoutResult,
  options: MatchOptions = {},
): Array<SourceRegion | undefined> {
  const opts = { ...DEFAULTS, ...options };
  const bands = clusterRows(layout.lines, opts.clusterRatio);
  const used = new Array<boolean>(bands.length).fill(false);
  const result = new Array<SourceRegion | undefined>(rows.length).fill(undefined);

  // 第一轮：按商品编码精确匹配（最可靠）。
  rows.forEach((row, index) => {
    const code = normalize(row.code);
    if (code.length < opts.minCodeLength) return;
    const bandIndex = bands.findIndex((band, i) => !used[i] && normalize(band.text).includes(code));
    if (bandIndex >= 0) {
      used[bandIndex] = true;
      result[index] = toSourceRegion(bands[bandIndex].box, 0.95);
    }
  });

  // 第二轮：未命中行按名称相似度兜底（取剩余行带中相似度最高且达阈值者）。
  rows.forEach((row, index) => {
    if (result[index]) return;
    const name = normalize(row.name);
    if (!name) return;
    let best = -1;
    let bestScore = opts.minNameSimilarity;
    bands.forEach((band, i) => {
      if (used[i]) return;
      const score = normalize(band.text).includes(name) ? 1 : bigramSimilarity(name, normalize(band.text));
      if (score >= bestScore) {
        bestScore = score;
        best = i;
      }
    });
    if (best >= 0) {
      used[best] = true;
      result[index] = toSourceRegion(bands[best].box, Math.min(0.9, Math.max(0.5, bestScore)));
    }
  });

  return result;
}

/** 把文字行按垂直中心聚类成行带（一行可能由多段文字组成）。 */
function clusterRows(lines: OcrLayoutLine[], clusterRatio: number): RowBand[] {
  const valid = lines.filter((line) => isFiniteBox(line.box) && line.box.h > 0);
  if (!valid.length) return [];
  const sorted = [...valid].sort((a, b) => centerY(a) - centerY(b));
  const medianH = median(sorted.map((line) => line.box.h)) || 0.02;
  const tol = medianH * clusterRatio;

  const groups: OcrLayoutLine[][] = [];
  let currentCy = Number.NEGATIVE_INFINITY;
  for (const line of sorted) {
    const cy = centerY(line);
    const last = groups[groups.length - 1];
    if (last && Math.abs(cy - currentCy) <= tol) {
      last.push(line);
      currentCy = last.reduce((sum, l) => sum + centerY(l), 0) / last.length;
    } else {
      groups.push([line]);
      currentCy = cy;
    }
  }

  return groups.map((group) => ({
    box: unionBox(group.map((line) => line.box)),
    text: [...group].sort((a, b) => a.box.x - b.box.x).map((line) => line.text).join(" "),
  }));
}

function toSourceRegion(box: SourceRegionBox, confidence: number): SourceRegion {
  const x = clamp01(box.x);
  const y = clamp01(box.y);
  return {
    version: 1,
    source: "layout_ocr",
    kind: "row",
    box: {
      x,
      y,
      w: Math.min(1 - x, clamp01(box.w)),
      h: Math.min(1 - y, clamp01(box.h)),
    },
    confidence: clamp01(confidence),
  };
}

function unionBox(boxes: SourceRegionBox[]): SourceRegionBox {
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w));
  const y1 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function centerY(line: OcrLayoutLine): number {
  return line.box.y + line.box.h / 2;
}

function normalize(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, "").toLowerCase();
}

/** 字符 bigram Jaccard 相似度，适配中文名称的近似匹配。 */
function bigramSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a.length === 1 || b.length === 1) return a === b || b.includes(a) ? 1 : 0;
  const setA = bigrams(a);
  const setB = bigrams(b);
  let inter = 0;
  for (const gram of setA) if (setB.has(gram)) inter += 1;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

function bigrams(value: string): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i < value.length - 1; i += 1) set.add(value.slice(i, i + 2));
  return set;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function isFiniteBox(box: SourceRegionBox): boolean {
  return [box.x, box.y, box.w, box.h].every(Number.isFinite);
}
