import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";

export const runtime = "nodejs";

function observationKey(code: string | null | undefined, name: string) {
  return code ? `code:${code}|name:${name}` : `name:${name}`;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q") ?? "";
  const onlyConflicts = searchParams.get("onlyConflicts") === "true";
  const page = Math.max(1, Number(searchParams.get("page") ?? 1));
  const pageSize = Math.min(100, Math.max(10, Number(searchParams.get("pageSize") ?? 20)));

  // onlyConflicts 进入 where 以保证分页 total 准确。
  const where = {
    ...(q ? { OR: [{ name: { contains: q } }, { code: { contains: q } }] } : {}),
    ...(onlyConflicts ? { conflicts: { some: { status: "open" } } } : {}),
  };

  const [products, total] = await Promise.all([
    prisma.product.findMany({
      where,
      orderBy: [{ updatedAt: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { conflicts: true },
    }),
    prisma.product.count({ where }),
  ]);

  // 仅按本页产品名拉取观测记录，聚合出现次数与来源文档数。
  const names = Array.from(new Set(products.map((product) => product.name)));
  const observations = names.length
    ? await prisma.productObservation.findMany({
        where: { name: { in: names } },
        select: { cleanCode: true, name: true, documentId: true },
      })
    : [];

  const stats = new Map<string, { count: number; docs: Set<string> }>();
  for (const observation of observations) {
    const key = observationKey(observation.cleanCode, observation.name);
    const entry = stats.get(key) ?? { count: 0, docs: new Set<string>() };
    entry.count += 1;
    entry.docs.add(observation.documentId);
    stats.set(key, entry);
  }

  const enriched = products.map((product) => {
    const entry = stats.get(observationKey(product.code, product.name));
    return {
      ...product,
      observationCount: entry?.count ?? 0,
      sourceDocuments: entry?.docs.size ?? 0,
    };
  });

  return NextResponse.json({ products: enriched, total, page, pageSize });
}
