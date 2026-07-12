import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { excludeRecognitionRow, updateRecognitionRow } from "@/lib/workflows/rows";
import { handleRoute, notFound, parseJson } from "@/lib/api/http";

export const runtime = "nodejs";

const rowUpdateSchema = z.object({
  code: z.string().nullish(),
  name: z.string().optional(),
  unit: z.string().nullish(),
  qty: z.coerce.number().optional(),
  price: z.coerce.number().optional(),
  amount: z.coerce.number().optional(),
  remark: z.string().nullish(),
  extra: z.record(z.string(), z.unknown()).optional(),
});

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const { id } = await params;
    const body = await parseJson(request, rowUpdateSchema);
    // 更新 + 写 AuditLog 放进一个事务，保证审计与数据一致。
    const row = await prisma.$transaction((tx) =>
      updateRecognitionRow(
        id,
        {
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

    if (!row) throw notFound("Row not found");
    return NextResponse.json({ row });
  });
}

export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const { id } = await params;
    const row = await prisma.$transaction((tx) => excludeRecognitionRow(id, tx));
    if (!row) throw notFound("Row not found");
    return NextResponse.json({ row });
  });
}
