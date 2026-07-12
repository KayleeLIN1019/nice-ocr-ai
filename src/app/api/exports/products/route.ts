import { NextResponse } from "next/server";
import { buildProductExport, xlsxContentType } from "@/lib/workflows/exports";

export const runtime = "nodejs";

export async function POST() {
  return new NextResponse(await buildProductExport(), {
    headers: {
      "content-type": xlsxContentType,
      "content-disposition": 'attachment; filename="product-library.xlsx"',
    },
  });
}
