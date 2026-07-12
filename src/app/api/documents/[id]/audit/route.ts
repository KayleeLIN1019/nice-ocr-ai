import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { enqueueAuditJob } from "@/lib/queue/jobs";
import { enforceRateLimit } from "@/lib/ratelimit";

export const runtime = "nodejs";

/** 为单个文档入队审核任务。 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const limited = enforceRateLimit(request, "audit", 20, 60_000);
  if (limited) return limited;

  const { id } = await params;
  const document = await prisma.document.findUnique({ where: { id }, select: { batchId: true } });
  if (!document) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }
  const job = await enqueueAuditJob(id, document.batchId);
  return NextResponse.json({ queued: job ? 1 : 0 });
}
