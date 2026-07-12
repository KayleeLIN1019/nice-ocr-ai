import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { createRecognitionRow } from "@/lib/workflows/rows";
import { distinctScenarioIds } from "@/lib/fields/field-schema";
import { handleRoute, notFound, parseJson } from "@/lib/api/http";
import type { SearchMode } from "@/lib/workflows/exports";

export const runtime = "nodejs";

function textFilter(value: string, mode: SearchMode) {
  return mode === "exact" ? { equals: value } : { contains: value };
}

function summarizeMultiCodeProducts(rows: Array<{ name: string; code: string | null }>) {
  const byName = new Map<string, { total: number; blankCount: number; codes: Map<string, number> }>();
  for (const row of rows) {
    const name = row.name.trim();
    if (!name) continue;
    const entry = byName.get(name) ?? { total: 0, blankCount: 0, codes: new Map<string, number>() };
    entry.total += 1;
    const code = row.code?.trim() || "";
    if (code) entry.codes.set(code, (entry.codes.get(code) ?? 0) + 1);
    else entry.blankCount += 1;
    byName.set(name, entry);
  }

  return [...byName.entries()]
    .filter(([, entry]) => entry.codes.size > 1)
    .map(([name, entry]) => ({
      name,
      total: entry.total,
      blankCount: entry.blankCount,
      codes: [...entry.codes.entries()]
        .map(([code, count]) => ({ code, count }))
        .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
    }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}

export async function GET(request: Request) {
  return handleRoute(async () => {
    const { searchParams } = new URL(request.url);
    const page = Math.max(1, Number(searchParams.get("page") ?? 1));
    const pageSize = Math.min(200, Math.max(20, Number(searchParams.get("pageSize") ?? 50)));
    const q = searchParams.get("q")?.trim();
    const code = searchParams.get("code")?.trim();
    const name = searchParams.get("name")?.trim();
    const searchMode: SearchMode = searchParams.get("searchMode") === "exact" ? "exact" : "fuzzy";
    const where = {
      deletedAt: null,
      ...(searchParams.get("batchId") ? { batchId: searchParams.get("batchId") as string } : {}),
      ...(searchParams.get("status") ? { status: searchParams.get("status") as string } : {}),
      ...(searchParams.get("risk") ? { riskLevel: searchParams.get("risk") as string } : {}),
      ...(searchParams.get("auditState") ? { auditState: searchParams.get("auditState") as string } : {}),
      ...(searchParams.get("month") ? { normalizedMonth: searchParams.get("month") as string } : {}),
      ...(q ? { OR: [{ code: textFilter(q, searchMode) }, { name: textFilter(q, searchMode) }] } : {}),
      ...(code ? { code: textFilter(code, searchMode) } : {}),
      ...(name ? { name: textFilter(name, searchMode) } : {}),
    };
    const shouldSummarizeCodes = Boolean(q || name);

    const [rows, total, scopeBatches, codeSummaryRows] = await Promise.all([
      prisma.recognitionRow.findMany({
        where,
        // 稳定排序：createdAt 不随编辑变化，编辑后行不会跳到列表顶部（避免页面抖动）。
        orderBy: [{ createdAt: "desc" }, { rowIndex: "asc" }, { id: "asc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { document: true, batch: true },
      }),
      prisma.recognitionRow.count({ where }),
      // 整个过滤结果集涉及的去重批次（含场景），驱动「全部」视图的混场景列退化判断。
      prisma.recognitionRow.findMany({
        where,
        distinct: ["batchId"],
        select: { batch: { select: { scenarioId: true } } },
      }),
      shouldSummarizeCodes
        ? prisma.recognitionRow.findMany({
            where,
            select: { name: true, code: true },
          })
        : Promise.resolve([]),
    ]);

    const scenarioIds = distinctScenarioIds(scopeBatches.map((row) => row.batch.scenarioId));
    const multiCodeProducts = summarizeMultiCodeProducts(codeSummaryRows);

    return NextResponse.json({ rows, total, page, pageSize, scenarioIds, multiCodeProducts });
  });
}

const rowCreateSchema = z.object({
  documentId: z.string().min(1, "documentId is required"),
  afterRowId: z.string().nullish(),
  code: z.string().nullish(),
  name: z.string().optional(),
  unit: z.string().nullish(),
  qty: z.coerce.number().optional(),
  price: z.coerce.number().optional(),
  amount: z.coerce.number().optional(),
  remark: z.string().nullish(),
  extra: z.record(z.string(), z.unknown()).optional(),
});

export async function POST(request: Request) {
  return handleRoute(async () => {
    const body = await parseJson(request, rowCreateSchema);
    // 新建行 + 重排 rowIndex + 写 AuditLog 放进一个事务，保证原子性。
    const row = await prisma.$transaction((tx) =>
      createRecognitionRow(
        {
          documentId: body.documentId,
          afterRowId: body.afterRowId ?? null,
          code: body.code,
          name: body.name,
          unit: body.unit,
          qty: body.qty,
          price: body.price,
          amount: body.amount,
          remark: body.remark,
          extra: body.extra,
        },
        tx,
      ),
    );

    if (!row) throw notFound("Document not found");
    return NextResponse.json({ row }, { status: 201 });
  });
}
