import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";

export const runtime = "nodejs";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const document = await prisma.document.findUnique({ where: { id } });
  if (!document || !document.storedPath) {
    return NextResponse.json({ error: "Image not found" }, { status: 404 });
  }

  const buffer = await readFile(document.storedPath);
  return new NextResponse(buffer, {
    headers: {
      "content-type": document.mimeType,
      "cache-control": "private, max-age=3600",
    },
  });
}
