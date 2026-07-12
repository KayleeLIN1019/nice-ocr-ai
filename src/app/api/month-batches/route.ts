import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { badRequest, handleRoute, parseJson } from "@/lib/api/http";

export const runtime = "nodejs";

function uniqueIds(ids: string[]) {
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const page = Math.max(1, Number(searchParams.get("page") ?? 1));
  const pageSize = Math.min(100, Math.max(5, Number(searchParams.get("pageSize") ?? 20)));
  const search = searchParams.get("search")?.trim();
  const month = searchParams.get("month")?.trim();
  const where = {
    ...(search ? { name: { contains: search } } : {}),
    ...(month ? { month } : {}),
  };

  const [monthBatches, total] = await Promise.all([
    prisma.monthlyBatch.findMany({
      where,
      orderBy: [{ month: "desc" }, { createdAt: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        items: {
          orderBy: { createdAt: "asc" },
          include: {
            batch: {
              select: {
                id: true,
                name: true,
                status: true,
                createdAt: true,
                _count: { select: { documents: true, rows: true } },
              },
            },
          },
        },
      },
    }),
    prisma.monthlyBatch.count({ where }),
  ]);

  return NextResponse.json({
    monthBatches: monthBatches.map(({ items, ...monthBatch }) => {
      const batches = items.map((item) => item.batch);
      return {
        ...monthBatch,
        batches,
        batchCount: batches.length,
        documentCount: batches.reduce((sum, batch) => sum + batch._count.documents, 0),
        rowCount: batches.reduce((sum, batch) => sum + batch._count.rows, 0),
      };
    }),
    total,
    page,
    pageSize,
  });
}

const monthlyBatchCreateSchema = z.object({
  name: z.string().optional(),
  month: z.string().regex(/^\d{4}-\d{2}$/, "month must be YYYY-MM"),
  notes: z.string().nullish(),
  batchIds: z.array(z.string()).optional(),
});

export async function POST(request: Request) {
  return handleRoute(async () => {
    const body = await parseJson(request, monthlyBatchCreateSchema);
    const batchIds = uniqueIds(body.batchIds ?? []);
    const month = body.month.trim();
    const name = body.name?.trim() || `${month} 月份批次`;

    if (batchIds.length) {
      const existing = await prisma.batch.count({ where: { id: { in: batchIds } } });
      if (existing !== batchIds.length) {
        throw badRequest("包含不存在的批次");
      }
    }

    const monthBatch = await prisma.$transaction(async (tx) => {
      const created = await tx.monthlyBatch.create({
        data: {
          name,
          month,
          notes: body.notes ? String(body.notes) : null,
        },
      });
      if (batchIds.length) {
        await tx.monthlyBatchItem.createMany({
          data: batchIds.map((batchId) => ({ monthlyBatchId: created.id, batchId })),
        });
      }
      return created;
    });

    return NextResponse.json({ monthBatch }, { status: 201 });
  });
}
