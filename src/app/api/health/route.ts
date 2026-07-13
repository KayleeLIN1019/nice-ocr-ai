import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";

export const runtime = "nodejs";
// 健康检查需反映实时状态，禁用任何缓存。
export const dynamic = "force-dynamic";

/** 存活/就绪探针：ping 数据库，正常 200 {status:"ok"}，异常 503 {status:"degraded"}。 */
export async function GET() {
  const startedAt = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({
      status: "ok",
      db: "up",
      latencyMs: Date.now() - startedAt,
      time: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json(
      {
        status: "degraded",
        db: "down",
        error: error instanceof Error ? error.message : String(error),
        time: new Date().toISOString(),
      },
      { status: 503 },
    );
  }
}
