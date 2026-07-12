import { NextResponse } from "next/server";
import { rebuildProductLibrary } from "@/lib/workflows/products";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  return NextResponse.json(await rebuildProductLibrary({ includePending: Boolean(body.includePending) }));
}
