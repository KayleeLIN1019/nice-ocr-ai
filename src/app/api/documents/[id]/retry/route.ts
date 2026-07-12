import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { badRequest, handleRoute } from "@/lib/api/http";
import { enqueueRecognitionJob } from "@/lib/queue/jobs";
import { enforceRateLimit } from "@/lib/ratelimit";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const limited = enforceRateLimit(request, "retry", 30, 60_000);
  if (limited) return limited;

  return handleRoute(async () => {
    const { id } = await params;
    const document = await prisma.document.findUnique({ where: { id } });
    if (!document) {
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }

    const job = await enqueueRecognitionJob(document.id, document.batchId);
    if (!job) throw badRequest("该文档已有排队或处理中的识别任务，请勿重复加入队列", "JOB_ALREADY_IN_FLIGHT");

    await prisma.document.update({
      where: { id },
      data: { status: "queued" },
    });
    // 重新入队识别 → 批次回到「处理中」，待 worker 排空后由其重新结算终态。
    await prisma.batch.update({
      where: { id: document.batchId },
      data: { status: "processing" },
    });
    return NextResponse.json({ job }, { status: 201 });
  });
}
