import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";

export const runtime = "nodejs";

function safeParseArray(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function variantKind(type: string): "code" | "name" | null {
  if (type === "NAME_MULTI_CODE") return "code";
  if (type === "CODE_NAME_CONFLICT") return "name";
  return null;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const page = Math.max(1, Number(searchParams.get("page") ?? 1));
  const pageSize = Math.min(100, Math.max(10, Number(searchParams.get("pageSize") ?? 20)));
  const where = {
    ...(searchParams.get("status") ? { status: searchParams.get("status") as string } : {}),
    ...(searchParams.get("severity") ? { severity: searchParams.get("severity") as string } : {}),
  };

  const [conflicts, total] = await Promise.all([
    prisma.productConflict.findMany({
      where,
      orderBy: [{ severity: "desc" }, { createdAt: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { product: true },
    }),
    prisma.productConflict.count({ where }),
  ]);

  const sourceIds = new Set<string>();
  for (const conflict of conflicts) {
    for (const id of safeParseArray(conflict.sourceRowIdsJson)) sourceIds.add(id);
  }
  const sourceRows = sourceIds.size
    ? await prisma.recognitionRow.findMany({
        where: { id: { in: [...sourceIds] }, deletedAt: null },
        select: { id: true, code: true, name: true },
      })
    : [];
  const rowsById = new Map(sourceRows.map((row) => [row.id, row]));

  const enriched = conflicts.map((conflict) => {
    const kind = variantKind(conflict.type);
    if (!kind) return conflict;

    const groups = new Map<string, number>();
    for (const id of safeParseArray(conflict.sourceRowIdsJson)) {
      const row = rowsById.get(id);
      if (!row) continue;
      const value = kind === "code" ? row.code?.trim() || "空编码" : row.name.trim();
      if (!value) continue;
      groups.set(value, (groups.get(value) ?? 0) + 1);
    }

    const maxCount = Math.max(0, ...groups.values());
    const items = [...groups.entries()]
      .map(([value, count]) => ({ value, count, isMinority: maxCount > 0 && count < maxCount }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, "zh"));

    return { ...conflict, variants: { kind, items } };
  });

  return NextResponse.json({ conflicts: enriched, total, page, pageSize });
}
