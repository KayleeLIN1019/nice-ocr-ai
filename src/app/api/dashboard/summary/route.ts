import { NextResponse } from "next/server";
import { buildDashboardSummary, DashboardScopeNotFoundError } from "@/lib/workflows/dashboard";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  try {
    const summary = await buildDashboardSummary({
      monthlyBatchId: searchParams.get("monthlyBatchId"),
    });
    return NextResponse.json(summary);
  } catch (error) {
    if (error instanceof DashboardScopeNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    throw error;
  }
}
