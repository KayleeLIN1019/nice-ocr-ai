import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { cancelJob } from "@/lib/queue/maintenance";
import { handleRoute } from "@/lib/api/http";
import { enforceRateLimit } from "@/lib/ratelimit";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const limited = enforceRateLimit(request, "queue-cancel", 60, 60_000);
  if (limited) return limited;

  return handleRoute(async () => {
    const { id } = await params;
    const result = await prisma.$transaction((tx) => cancelJob(id, tx));
    return NextResponse.json(result);
  });
}
