import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { badRequest, handleRoute, notFound, parseJson } from "@/lib/api/http";

export const runtime = "nodejs";

function uniqueIds(ids: string[]) {
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
}

const monthlyBatchPatchSchema = z.object({
  name: z.string().optional(),
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/, "month must be YYYY-MM")
    .optional(),
  notes: z.string().nullish(),
  batchIds: z.array(z.string()).optional(),
});

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const { id } = await params;
    const body = await parseJson(request, monthlyBatchPatchSchema);
    const existing = await prisma.monthlyBatch.findUnique({ where: { id }, select: { id: true } });
    if (!existing) throw notFound("Monthly batch not found");

    const batchIds = body.batchIds ? uniqueIds(body.batchIds) : null;
    if (batchIds?.length) {
      const existingBatches = await prisma.batch.count({ where: { id: { in: batchIds } } });
      if (existingBatches !== batchIds.length) throw badRequest("包含不存在的批次");
    }

    const monthBatch = await prisma.$transaction(async (tx) => {
      const updated = await tx.monthlyBatch.update({
        where: { id },
        data: {
          ...(body.name !== undefined ? { name: body.name.trim() || "未命名月份批次" } : {}),
          ...(body.month !== undefined ? { month: body.month } : {}),
          ...(body.notes !== undefined ? { notes: body.notes ? String(body.notes) : null } : {}),
        },
      });
      if (batchIds) {
        await tx.monthlyBatchItem.deleteMany({ where: { monthlyBatchId: id } });
        if (batchIds.length) {
          await tx.monthlyBatchItem.createMany({
            data: batchIds.map((batchId) => ({ monthlyBatchId: id, batchId })),
          });
        }
      }
      return updated;
    });

    return NextResponse.json({ monthBatch });
  });
}

export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const existing = await prisma.monthlyBatch.findUnique({ where: { id }, select: { id: true } });
  if (!existing) {
    return NextResponse.json({ error: "Monthly batch not found" }, { status: 404 });
  }

  await prisma.$transaction([
    prisma.monthlyBatchItem.deleteMany({ where: { monthlyBatchId: id } }),
    prisma.monthlyBatch.delete({ where: { id } }),
  ]);

  return NextResponse.json({ ok: true });
}
