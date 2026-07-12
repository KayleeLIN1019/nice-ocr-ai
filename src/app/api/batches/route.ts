import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getRecognitionSettings, normalizeRecognitionStrategy } from "@/lib/recognition/settings";
import { normalizeApprovalMode } from "@/lib/recognition/review";
import { getExportTemplate } from "@/lib/workflows/export-templates";
import { handleRoute, parseJson } from "@/lib/api/http";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const page = Math.max(1, Number(searchParams.get("page") ?? 1));
  const pageSize = Math.min(100, Math.max(10, Number(searchParams.get("pageSize") ?? 20)));
  const where = {
    ...(searchParams.get("search") ? { name: { contains: searchParams.get("search") as string } } : {}),
    ...(searchParams.get("status") ? { status: searchParams.get("status") as string } : {}),
  };

  const [batches, total] = await Promise.all([
    prisma.batch.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        _count: {
          select: { documents: true, rows: true, jobs: true },
        },
      },
    }),
    prisma.batch.count({ where }),
  ]);

  // 按批次聚合行级状态，供列表展示审核进度（已确认/总行/冲突）。一次 groupBy 覆盖当前页全部批次。
  const batchIds = batches.map((batch) => batch.id);
  const [grouped, unfinishedRows] = batchIds.length
    ? await Promise.all([
        prisma.recognitionRow.groupBy({
          by: ["batchId", "status"],
          where: { batchId: { in: batchIds }, deletedAt: null },
          _count: { _all: true },
        }),
        prisma.recognitionRow.findMany({
          where: { batchId: { in: batchIds }, deletedAt: null, status: { not: "confirmed" } },
          orderBy: [{ batchId: "asc" }, { documentId: "asc" }, { rowIndex: "asc" }],
          select: {
            id: true,
            batchId: true,
            documentId: true,
            rowIndex: true,
            code: true,
            name: true,
            status: true,
            document: { select: { originalName: true } },
          },
        }),
      ])
    : [[], []];
  const progressMap = new Map<string, { total: number; confirmed: number; conflict: number }>();
  for (const entry of grouped) {
    const progress = progressMap.get(entry.batchId) ?? { total: 0, confirmed: 0, conflict: 0 };
    const count = entry._count._all;
    progress.total += count;
    if (entry.status === "confirmed") progress.confirmed += count;
    if (entry.status === "conflict") progress.conflict += count;
    progressMap.set(entry.batchId, progress);
  }
  const unfinishedMap = new Map<
    string,
    Array<{
      id: string;
      originalName: string;
      pendingRows: number;
      firstRowId: string;
      firstRowIndex: number;
      firstRowName: string;
      firstRowCode: string | null;
    }>
  >();
  const unfinishedDocMap = new Map<
    string,
    {
      batchId: string;
      id: string;
      originalName: string;
      pendingRows: number;
      firstRowId: string;
      firstRowIndex: number;
      firstRowName: string;
      firstRowCode: string | null;
    }
  >();
  for (const row of unfinishedRows) {
    const key = `${row.batchId}:${row.documentId}`;
    const existing = unfinishedDocMap.get(key);
    if (existing) {
      existing.pendingRows += 1;
      continue;
    }
    unfinishedDocMap.set(key, {
      batchId: row.batchId,
      id: row.documentId,
      originalName: row.document.originalName,
      pendingRows: 1,
      firstRowId: row.id,
      firstRowIndex: row.rowIndex,
      firstRowName: row.name,
      firstRowCode: row.code,
    });
  }
  for (const item of unfinishedDocMap.values()) {
    const list = unfinishedMap.get(item.batchId) ?? [];
    list.push({
      id: item.id,
      originalName: item.originalName,
      pendingRows: item.pendingRows,
      firstRowId: item.firstRowId,
      firstRowIndex: item.firstRowIndex,
      firstRowName: item.firstRowName,
      firstRowCode: item.firstRowCode,
    });
    unfinishedMap.set(item.batchId, list);
  }
  const withProgress = batches.map((batch) => ({
    ...batch,
    progress: progressMap.get(batch.id) ?? { total: 0, confirmed: 0, conflict: 0 },
    unfinishedDocuments: unfinishedMap.get(batch.id) ?? [],
  }));

  return NextResponse.json({ batches: withProgress, total, page, pageSize });
}

const batchCreateSchema = z.object({
  name: z.string().optional(),
  notes: z.string().nullish(),
  strategy: z.string().optional(),
  approvalMode: z.string().optional(),
  primaryProviderKey: z.string().nullish(),
  primaryModelId: z.string().nullish(),
  secondaryProviderKey: z.string().nullish(),
  secondaryModelId: z.string().nullish(),
  /** 绑定导出模板；选模板时自动带出其声明的抽取场景 */
  exportTemplateId: z.string().nullish(),
  /** 抽取场景；缺省由 exportTemplateId 派生，再回退全局活动场景 */
  scenarioId: z.string().nullish(),
});

export async function POST(request: Request) {
  return handleRoute(async () => {
    const body = await parseJson(request, batchCreateSchema);
    // 未显式指定时，审批模式与主/副识别模型均继承设置页全局默认。
    const defaults = (await getRecognitionSettings()).defaults;
    const approvalMode = body.approvalMode
      ? normalizeApprovalMode(String(body.approvalMode))
      : defaults.approvalMode;
    const strategy = body.strategy
      ? normalizeRecognitionStrategy(String(body.strategy), defaults.strategy)
      : defaults.strategy;
    const pickKey = (value: unknown, fallback: string | null) => {
      const normalized = value == null ? "" : String(value).trim();
      return normalized ? normalized : fallback;
    };
    // 绑定导出模板；场景优先取显式值，否则由模板声明派生（选模板即带出场景），再回退全局。
    const exportTemplateId = body.exportTemplateId ? String(body.exportTemplateId).trim() || null : null;
    const derivedScenarioId = exportTemplateId
      ? (getExportTemplate(exportTemplateId).scenarioId ?? null)
      : null;
    const scenarioId = body.scenarioId ? String(body.scenarioId).trim() || null : derivedScenarioId;
    const batch = await prisma.batch.create({
      data: {
        name: String(body.name ?? "未命名批次"),
        notes: body.notes ? String(body.notes) : null,
        strategy,
        approvalMode,
        primaryProviderKey: pickKey(body.primaryProviderKey, defaults.primaryProviderKey),
        primaryModelId: pickKey(body.primaryModelId, defaults.primaryModelId),
        secondaryProviderKey: pickKey(body.secondaryProviderKey, defaults.secondaryProviderKey),
        secondaryModelId: pickKey(body.secondaryModelId, defaults.secondaryModelId),
        exportTemplateId,
        scenarioId,
        status: "draft",
      },
    });
    return NextResponse.json({ batch }, { status: 201 });
  });
}
