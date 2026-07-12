import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";

export const runtime = "nodejs";

/**
 * 标记开始人工处理某单据（task 1 处理计时起点）。set-once：仅当 reviewStartedAt 为空时写入，
 * 重复打开同一单据不会刷新起点。配合确认收口时写入的 reviewCompletedAt，得出单据人工处理时长。
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const document = await prisma.document.findUnique({ where: { id }, select: { reviewStartedAt: true } });
  if (!document) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }
  if (!document.reviewStartedAt) {
    await prisma.document.update({ where: { id }, data: { reviewStartedAt: new Date() } });
  }
  return NextResponse.json({ ok: true });
}
