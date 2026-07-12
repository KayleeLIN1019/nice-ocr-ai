import { rm } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { env } from "@/lib/env";
import { computeReviewState, emptyRowStats, rowStatsByDocument } from "@/lib/workflows/documents";

export const runtime = "nodejs";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const batch = await prisma.batch.findUnique({
    where: { id },
    include: {
      documents: { orderBy: { createdAt: "desc" } },
      _count: { select: { rows: true, jobs: true, documents: true } },
    },
  });

  if (!batch) {
    return NextResponse.json({ error: "Batch not found" }, { status: 404 });
  }

  // 汇总每个文档的行状态，供审核台文档选择器可视化“做了哪些”。
  const grouped = await prisma.recognitionRow.groupBy({
    by: ["documentId", "status"],
    where: { batchId: id, deletedAt: null },
    _count: { _all: true },
  });
  const statMap = rowStatsByDocument(grouped);

  const documents = batch.documents.map((document) => {
    const stat = statMap.get(document.id) ?? emptyRowStats();
    return { ...document, rowStats: stat, reviewState: computeReviewState(stat) };
  });

  return NextResponse.json({ batch: { ...batch, documents } });
}

// 封批/撤销：{ closed: boolean } → 写入/清除 closedAt（审核收口标记，不改 status）。
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { closed?: boolean };
  const existing = await prisma.batch.findUnique({ where: { id }, select: { id: true } });
  if (!existing) {
    return NextResponse.json({ error: "Batch not found" }, { status: 404 });
  }
  const batch = await prisma.batch.update({
    where: { id },
    data: { closedAt: body.closed ? new Date() : null },
  });
  return NextResponse.json({ batch });
}

/**
 * 删除整个批次：所有关联记录均为 onDelete: Restrict，必须在事务内按「子→父」顺序
 * 逐表清理，最后删批次本身；随后清理磁盘上的原图目录与各文档的 attempts 目录。
 * 删除前拒绝仍有识别 job 在执行(active)的批次，避免与 worker 写库竞态。
 */
export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const batch = await prisma.batch.findUnique({
    where: { id },
    select: { id: true, documents: { select: { id: true } } },
  });
  if (!batch) {
    return NextResponse.json({ error: "Batch not found" }, { status: 404 });
  }

  const activeJobs = await prisma.recognitionJob.count({ where: { batchId: id, status: "active" } });
  if (activeJobs > 0) {
    return NextResponse.json({ error: "批次正在识别中，请稍后再删除" }, { status: 409 });
  }

  const documentIds = batch.documents.map((document) => document.id);

  await prisma.$transaction([
    prisma.monthlyBatchItem.deleteMany({ where: { batchId: id } }),
    prisma.productObservation.deleteMany({ where: { batchId: id } }),
    prisma.recognitionRow.deleteMany({ where: { batchId: id } }),
    prisma.extractionAttempt.deleteMany({ where: { documentId: { in: documentIds } } }),
    prisma.recognitionJob.deleteMany({ where: { batchId: id } }),
    prisma.exportRecord.deleteMany({ where: { batchId: id } }),
    prisma.document.deleteMany({ where: { batchId: id } }),
    prisma.batch.delete({ where: { id } }),
  ]);

  // 磁盘清理：原图按 batchId 归档目录、attempts 按 documentId 目录。失败不影响删除结果。
  await rm(path.join(env.storageDir, "originals", id), { recursive: true, force: true }).catch(() => {});
  await Promise.all(
    documentIds.map((documentId) =>
      rm(path.join(env.storageDir, "attempts", documentId), { recursive: true, force: true }).catch(() => {}),
    ),
  );

  return NextResponse.json({ ok: true, deletedDocuments: documentIds.length });
}
