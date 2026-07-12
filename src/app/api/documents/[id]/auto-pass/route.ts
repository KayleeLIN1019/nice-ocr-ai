import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { badRequest, handleRoute, notFound } from "@/lib/api/http";
import { confirmRecognitionRows } from "@/lib/workflows/rows";
import { scheduleProductLibraryRebuild } from "@/lib/workflows/products";
import { buildDocumentTriage } from "@/lib/review/triage";

export const runtime = "nodejs";

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const { id } = await params;
    const document = await prisma.document.findUnique({
      where: { id },
      include: {
        rows: { where: { deletedAt: null }, orderBy: { rowIndex: "asc" } },
      },
    });
    if (!document) throw notFound("Document not found");

    const triage = buildDocumentTriage(document.rows);
    if (!triage.document.autoPassEligible) {
      throw badRequest(
        triage.document.blockers.length ? triage.document.blockers.join("；") : "当前单据不满足自动通过条件",
        "AUTO_PASS_BLOCKED",
      );
    }

    const updated = await prisma.$transaction((tx) =>
      confirmRecognitionRows({ documentId: id, onlyLowRisk: false }, tx),
    );
    if (updated && updated > 0) scheduleProductLibraryRebuild();
    return NextResponse.json({ updated: updated ?? 0, triage: triage.document });
  });
}
