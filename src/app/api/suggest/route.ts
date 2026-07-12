import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { handleRoute } from "@/lib/api/http";
import {
  buildCorrectionMap,
  normalizeCorrectionKey,
  observationsFromAuditDiff,
} from "@/lib/recognition/corrections";
import { isShortProductCode } from "@/lib/validation/rules";

export const runtime = "nodejs";

function safeJsonObject(text: string | null | undefined): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** 词语联想候选上限：商品名可能较多，单位很少；超出部分截断。 */
const MAX_NAMES = 1000;

/** 按出现频次降序、同频按名称排序，截断到上限后返回值数组。 */
function rankByFrequency(freq: Map<string, number>, limit?: number): string[] {
  const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh"));
  const sliced = limit ? sorted.slice(0, limit) : sorted;
  return sliced.map(([value]) => value);
}

/** 名称归一：NFKC + 小写 + 去空白，与审核台行名匹配一致。 */
function normalizeName(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, "").trim();
}

/** 编码归一：NFKC + trim；短码通常是 OCR 行号误入编码列，不进入联想库。 */
function normalizeCode(value: string | null | undefined): string {
  const code = String(value ?? "")
    .normalize("NFKC")
    .trim();
  return code && !isShortProductCode(code) ? code : "";
}

function addRankedPair(map: Map<string, Map<string, number>>, key: string, value: string, count: number) {
  if (!key || !value) return;
  const inner = map.get(key) ?? new Map<string, number>();
  inner.set(value, (inner.get(value) ?? 0) + count);
  map.set(key, inner);
}

function rankedPairObject(map: Map<string, Map<string, number>>) {
  return Object.fromEntries(
    [...map.entries()].map(([key, values]) => [
      key,
      [...values.entries()]
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, "zh")),
    ]),
  );
}

/**
 * 审核台词语联想数据源（item 1）：从资料库汇总商品名与单位候选，**按使用频次降序**排列，
 * 让最常用的项排在 <datalist> 前面。频次取两处之和：产品观测 + 已确认识别行（人工校验过，名称干净，
 * 即使产品观测尚未重建也有真实频次信号）。产品库中尚无频次的名称/单位以频次 0 补入，保证主数据也能被联想到。
 */
export async function GET() {
  return handleRoute(async () => {
    const [
      obsNameGroups,
      obsUnitGroups,
      obsPairGroups,
      rowNameGroups,
      rowUnitGroups,
      rowPairGroups,
      products,
    ] = await Promise.all([
      prisma.productObservation.groupBy({ by: ["name"], _count: { _all: true } }),
      prisma.productObservation.groupBy({ by: ["unit"], _count: { _all: true } }),
      prisma.productObservation.groupBy({ by: ["cleanCode", "name"], _count: { _all: true } }),
      prisma.recognitionRow.groupBy({
        by: ["name"],
        where: { status: "confirmed", deletedAt: null },
        _count: { _all: true },
      }),
      prisma.recognitionRow.groupBy({
        by: ["unit"],
        where: { status: "confirmed", deletedAt: null },
        _count: { _all: true },
      }),
      prisma.recognitionRow.groupBy({
        by: ["code", "name"],
        where: { status: "confirmed", deletedAt: null },
        _count: { _all: true },
      }),
      prisma.product.findMany({ select: { code: true, name: true, unit: true, price: true } }),
    ]);

    // 产品库（名称/单位/单价）：供审核台前端做模糊匹配建议（名称相似度 + 单价/单位吻合）。
    const library = products
      .filter((product) => product.name?.trim())
      .map((product) => ({
        name: product.name.trim(),
        unit: product.unit?.trim() || null,
        price: product.price ?? null,
      }));

    // 名称→单位映射（task 2）：以产品库为准，供审核台按当前行商品名联想单位。
    const unitByName: Record<string, string> = {};
    for (const product of products) {
      const name = product.name?.trim();
      const unit = product.unit?.trim();
      if (name && unit) {
        const key = normalizeName(name);
        if (key && !(key in unitByName)) unitByName[key] = unit;
      }
    }

    const nameFreq = new Map<string, number>();
    const codeFreq = new Map<string, number>();
    const unitFreq = new Map<string, number>();
    const namesByCode = new Map<string, Map<string, number>>();
    const codesByName = new Map<string, Map<string, number>>();
    const addName = (value: string | null | undefined, count: number) => {
      const name = value?.trim();
      if (name) nameFreq.set(name, (nameFreq.get(name) ?? 0) + count);
    };
    const addCode = (value: string | null | undefined, count: number) => {
      const code = normalizeCode(value);
      if (code) codeFreq.set(code, (codeFreq.get(code) ?? 0) + count);
    };
    const addUnit = (value: string | null | undefined, count: number) => {
      const unit = value?.trim();
      if (unit) unitFreq.set(unit, (unitFreq.get(unit) ?? 0) + count);
    };
    const addProductPair = (
      codeValue: string | null | undefined,
      nameValue: string | null | undefined,
      count: number,
    ) => {
      const code = normalizeCode(codeValue);
      const name = nameValue?.trim();
      if (!code || !name) return;
      addCode(code, count);
      addRankedPair(namesByCode, code, name, count);
      addRankedPair(codesByName, normalizeName(name), code, count);
    };
    for (const group of [...obsNameGroups, ...rowNameGroups]) addName(group.name, group._count._all);
    for (const group of [...obsUnitGroups, ...rowUnitGroups]) addUnit(group.unit, group._count._all);
    for (const group of obsPairGroups) addProductPair(group.cleanCode, group.name, group._count._all);
    for (const group of rowPairGroups) addProductPair(group.code, group.name, group._count._all);

    // 产品库主数据补入（无观测者频次 0，排在已用过的项之后）。
    for (const product of products) {
      const name = product.name?.trim();
      const code = normalizeCode(product.code);
      const unit = product.unit?.trim();
      if (name && !nameFreq.has(name)) nameFreq.set(name, 0);
      if (code && !codeFreq.has(code)) codeFreq.set(code, 0);
      if (unit && !unitFreq.has(unit)) unitFreq.set(unit, 0);
      if (name && code) addProductPair(code, name, 0);
    }

    // 名称纠正建议（从历史人工修改学习）：受产品库名称保护（合法商品名不当作错误），
    // 仅供审核台一键采纳——绝不自动改库，避免"鸭爪→西瓜"这类误伤。
    const protectedForCorrections = new Set<string>();
    for (const product of products) {
      const key = normalizeCorrectionKey(product.name ?? "");
      if (key) protectedForCorrections.add(key);
    }
    for (const group of rowNameGroups) {
      const key = normalizeCorrectionKey(group.name ?? "");
      if (key) protectedForCorrections.add(key);
    }
    const correctionAudits = await prisma.auditLog.findMany({
      where: { entityType: "RecognitionRow", action: "update" },
      orderBy: { createdAt: "desc" },
      take: 5000,
      select: { beforeJson: true, afterJson: true },
    });
    const correctionMap = buildCorrectionMap(
      correctionAudits.flatMap((entry) =>
        observationsFromAuditDiff(safeJsonObject(entry.beforeJson), safeJsonObject(entry.afterJson)),
      ),
      { protectedBefore: protectedForCorrections },
    );
    const nameCorrections: Record<string, string> = {};
    for (const [before, after] of correctionMap.get("name") ?? []) nameCorrections[before] = after;

    return NextResponse.json({
      names: rankByFrequency(nameFreq, MAX_NAMES),
      codes: rankByFrequency(codeFreq),
      units: rankByFrequency(unitFreq),
      unitByName,
      namesByCode: rankedPairObject(namesByCode),
      codesByName: rankedPairObject(codesByName),
      nameCorrections,
      library,
    });
  });
}
