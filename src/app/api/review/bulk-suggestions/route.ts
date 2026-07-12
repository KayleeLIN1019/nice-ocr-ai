import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { handleRoute } from "@/lib/api/http";
import { buildCorrectionMap, observationsFromAuditDiff } from "@/lib/recognition/corrections";
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

function mode(values: string[]) {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh"))[0] ?? ["", 0];
}

export async function GET(request: Request) {
  return handleRoute(async () => {
    const { searchParams } = new URL(request.url);
    const documentId = searchParams.get("documentId") || "";
    const batchId = searchParams.get("batchId") || "";
    const where: Prisma.RecognitionRowWhereInput = {
      deletedAt: null,
      ...(documentId ? { documentId } : {}),
      ...(batchId ? { batchId } : {}),
    };

    const rows = await prisma.recognitionRow.findMany({
      where,
      select: { id: true, code: true, name: true, unit: true, status: true },
      orderBy: [{ documentId: "asc" }, { rowIndex: "asc" }],
      take: 2000,
    });

    const suggestions: Array<Record<string, unknown>> = [];
    const shortCodeRows = rows.filter((row) => isShortProductCode(row.code));
    if (shortCodeRows.length) {
      suggestions.push({
        id: "clear-short-codes",
        type: "clear_short_codes",
        title: `清空 ${shortCodeRows.length} 行少位编码`,
        description: "这些编码少于 3 位，通常是 OCR 把行号识别进了编码列。",
        severity: "warning",
        rowIds: shortCodeRows.map((row) => row.id),
        count: shortCodeRows.length,
      });
    }

    const byName = new Map<string, typeof rows>();
    const byCode = new Map<string, typeof rows>();
    for (const row of rows) {
      const name = row.name.trim();
      const code = row.code?.trim() || "";
      if (name) byName.set(name, [...(byName.get(name) ?? []), row]);
      if (code && !isShortProductCode(code)) byCode.set(code, [...(byCode.get(code) ?? []), row]);
    }

    for (const [name, group] of byName) {
      const codes = group.map((row) => row.code?.trim() || "").filter(Boolean);
      const distinct = [...new Set(codes)];
      if (distinct.length <= 1 || group.length < 2) continue;
      const [targetCode, count] = mode(codes);
      suggestions.push({
        id: `name-code-${name}`,
        type: "replace_code_by_name",
        title: `统一「${name}」的商品编码`,
        description: `当前出现 ${distinct.length} 个编码，建议采用出现最多的 ${targetCode}（${count} 次）。`,
        severity: "warning",
        name,
        toCode: targetCode,
        rowIds: group.map((row) => row.id),
        count: group.length,
      });
    }

    for (const [code, group] of byCode) {
      const names = group.map((row) => row.name.trim()).filter(Boolean);
      const distinct = [...new Set(names)];
      if (distinct.length <= 1 || group.length < 2) continue;
      const [targetName, count] = mode(names);
      suggestions.push({
        id: `code-name-${code}`,
        type: "replace_name_by_code",
        title: `统一编码 ${code} 的商品名`,
        description: `当前出现 ${distinct.length} 个名称，建议采用出现最多的「${targetName}」（${count} 次）。`,
        severity: "danger",
        code,
        toName: targetName,
        rowIds: group.map((row) => row.id),
        count: group.length,
      });
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
      { minOccurrences: 3 },
    );
    for (const field of ["name", "code"] as const) {
      for (const [beforeKey, after] of correctionMap.get(field) ?? []) {
        const matched = rows.filter((row) => String(row[field] ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, "").trim() === beforeKey);
        if (!matched.length) continue;
        suggestions.push({
          id: `learned-${field}-${beforeKey}`,
          type: "learned_correction",
          title: `套用历史修正：${field} → ${after}`,
          description: `历史人工多次做过相同修正，当前范围命中 ${matched.length} 行。`,
          severity: "info",
          field,
          toValue: after,
          rowIds: matched.map((row) => row.id),
          count: matched.length,
        });
      }
    }

    return NextResponse.json({ suggestions: suggestions.slice(0, 20) });
  });
}
