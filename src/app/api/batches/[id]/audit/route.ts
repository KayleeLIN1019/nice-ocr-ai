import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { enqueueAuditJob } from "@/lib/queue/jobs";
import { enforceRateLimit } from "@/lib/ratelimit";

export const runtime = "nodejs";

/** 为该批次中"含机器自动通过(ai_auto)已确认行"的文档入队审核任务。 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const limited = enforceRateLimit(request, "audit", 20, 60_000);
  if (limited) return limited;

  const { id: batchId } = await params;
  const grouped = await prisma.recognitionRow.groupBy({
    by: ["documentId"],
    where: { batchId, reviewClass: "ai_auto", status: "confirmed", deletedAt: null },
  });

  let queued = 0;
  for (const entry of grouped) {
    const job = await enqueueAuditJob(entry.documentId, batchId);
    if (job) queued += 1;
  }

  return NextResponse.json({ documents: grouped.length, queued });
}
