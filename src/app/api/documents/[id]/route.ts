import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { detectProductConflictReasons } from "@/lib/products/conflicts";
import { buildDocumentTriage, rowIssueMap } from "@/lib/review/triage";

export const runtime = "nodejs";

function safeParseReasons(raw?: string | null): string[] {
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function mergeReasons(raw: string | null | undefined, extra: string[]) {
  return JSON.stringify([...new Set([...safeParseReasons(raw), ...extra])]);
}

function elevateRisk(current: string, reasons: string[]) {
  if (current === "high") return "high";
  if (reasons.includes("CODE_NAME_CONFLICT")) return "high";
  if (reasons.includes("NAME_MULTI_CODE")) return "medium";
  return current;
}

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const document = await prisma.document.findUnique({
    where: { id },
    include: {
      rows: { where: { deletedAt: null }, orderBy: { rowIndex: "asc" } },
      attempts: { orderBy: { startedAt: "desc" } },
      jobs: { orderBy: { createdAt: "desc" } },
    },
  });

  if (!document) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }

  const names = Array.from(new Set(document.rows.map((row) => row.name).filter(Boolean)));
  const codes = Array.from(new Set(document.rows.map((row) => row.code?.trim()).filter(Boolean) as string[]));
  const relatedRows = names.length || codes.length
    ? await prisma.recognitionRow.findMany({
        where: {
          deletedAt: null,
          OR: [
            ...(names.length ? [{ name: { in: names } }] : []),
            ...(codes.length ? [{ code: { in: codes } }] : []),
          ],
        },
        select: { id: true, code: true, name: true, unit: true },
      })
    : [];
  const productReasonMap = detectProductConflictReasons(relatedRows.map((row) => ({ rowId: row.id, code: row.code, name: row.name, unit: row.unit })));

  // 副模型逐行候选名（item 1 审核提速）：取最近一次 pass2 识别结果，按行位置映射出"另一个模型读到的名字"，
  // 供审核台作为一键候选展示（数字常一致、名字常分歧，给人快速二选一）。
  let altNames: Array<string | null> = [];
  const secondPass = document.attempts.find((attempt) => {
    try {
      return (JSON.parse(attempt.validationJson ?? "{}") as { pass?: number })?.pass === 2;
    } catch {
      return false;
    }
  });
  if (secondPass?.parsedJson) {
    try {
      const parsed = JSON.parse(secondPass.parsedJson) as { rows?: Array<{ name?: unknown }>; items?: Array<{ name?: unknown }> };
      const list = parsed.rows ?? parsed.items ?? [];
      altNames = list.map((row) => (typeof row?.name === "string" ? row.name : null));
    } catch {
      altNames = [];
    }
  }

  const rows = document.rows.map((row) => {
    const alt = altNames[row.rowIndex - 1] ?? null;
    const productReasons = (productReasonMap.get(row.id) ?? []).filter(
      (reason) => reason === "NAME_MULTI_CODE" || reason === "CODE_NAME_CONFLICT",
    );
    return {
      ...row,
      riskLevel: elevateRisk(row.riskLevel, productReasons),
      riskReasonsJson: productReasons.length ? mergeReasons(row.riskReasonsJson, productReasons) : row.riskReasonsJson,
      altName: alt && alt !== row.name ? alt : null,
    };
  });

  const triage = buildDocumentTriage(rows);
  const triageByRowId = rowIssueMap(triage);
  const rowsWithTriage = rows.map((row) => ({
    ...row,
    triage: triageByRowId.get(row.id) ?? null,
    fieldIssues: triageByRowId.get(row.id)?.fieldIssues ?? [],
  }));

  const documentReasons = rowsWithTriage.flatMap((row) => safeParseReasons(row.riskReasonsJson));
  const riskReasonsJson = documentReasons.length ? mergeReasons(document.riskReasonsJson, documentReasons) : document.riskReasonsJson;
  const riskLevel = documentReasons.includes("CODE_NAME_CONFLICT")
    ? "high"
    : documentReasons.includes("NAME_MULTI_CODE") && document.riskLevel === "low"
      ? "medium"
      : document.riskLevel;

  return NextResponse.json({ document: { ...document, riskLevel, riskReasonsJson, rows: rowsWithTriage, triage: triage.document } });
}
