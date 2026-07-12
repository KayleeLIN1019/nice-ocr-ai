import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { retryFailedJobs } from "@/lib/queue/maintenance";
import { handleRoute, parseJson } from "@/lib/api/http";
import { enforceRateLimit } from "@/lib/ratelimit";

export const runtime = "nodejs";

const retryFailedSchema = z.object({ batchId: z.string().nullish() });

export async function POST(request: Request) {
  const limited = enforceRateLimit(request, "queue-retry-failed", 20, 60_000);
  if (limited) return limited;

  return handleRoute(async () => {
    const body = await parseJson(request, retryFailedSchema);
    const result = await prisma.$transaction((tx) => retryFailedJobs(body.batchId ?? undefined, tx));
    return NextResponse.json(result);
  });
}
