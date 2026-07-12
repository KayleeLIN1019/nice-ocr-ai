import { NextResponse } from "next/server";
import { listJobs } from "@/lib/queue/list";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const page = Math.max(1, Number(searchParams.get("page") ?? 1));
  const pageSize = Math.min(100, Math.max(10, Number(searchParams.get("pageSize") ?? 20)));
  const result = await listJobs({
    status: searchParams.get("status") || undefined,
    type: searchParams.get("type") || undefined,
    batchId: searchParams.get("batchId") || undefined,
    page,
    pageSize,
  });
  return NextResponse.json(result);
}
