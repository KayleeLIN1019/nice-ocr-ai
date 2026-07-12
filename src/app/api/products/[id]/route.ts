import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { AUDITED_PRODUCT_FIELDS, diffFields } from "@/lib/audit-log";
import { handleRoute, notFound, parseJson } from "@/lib/api/http";

export const runtime = "nodejs";

const productPatchSchema = z.object({
  code: z.string().nullish(),
  name: z.string().optional(),
  unit: z.string().nullish(),
  aliases: z.array(z.string()).optional(),
  remark: z.string().nullish(),
});

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const { id } = await params;
    const body = await parseJson(request, productPatchSchema);

    // 更新 + 写 AuditLog 放进一个事务，保证审计与数据一致；审计只记录字段级 diff。
    const result = await prisma.$transaction(async (tx) => {
      const before = await tx.product.findUnique({ where: { id } });
      if (!before) return null;

      const product = await tx.product.update({
        where: { id },
        data: {
          code: body.code ?? undefined,
          name: body.name ?? undefined,
          unit: body.unit ?? undefined,
          aliasesJson: body.aliases ? JSON.stringify(body.aliases) : undefined,
          remark: body.remark ?? undefined,
        },
      });

      const diff = diffFields(before, product, AUDITED_PRODUCT_FIELDS);
      await tx.auditLog.create({
        data: {
          entityType: "Product",
          entityId: id,
          action: "update",
          beforeJson: JSON.stringify(diff.before),
          afterJson: JSON.stringify(diff.after),
        },
      });
      return product;
    });

    if (!result) throw notFound("Product not found");
    return NextResponse.json({ product: result });
  });
}
