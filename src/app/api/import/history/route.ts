import { NextResponse } from "next/server";
import { importPurchaseHistory } from "@/lib/workflows/import-history";
import { badRequest, handleRoute } from "@/lib/api/http";

export const runtime = "nodejs";
// 大文件（约 2000 个分表、上万条记录）解析+写库需要较长时间。
export const maxDuration = 300;

export async function POST(request: Request) {
  return handleRoute(async () => {
    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) throw badRequest("缺少上传文件 file");
    // withCode 默认 true；显式传 "false" 则不写入编码。
    const withCode = formData.get("withCode") !== "false";
    const buffer = Buffer.from(await file.arrayBuffer());
    return NextResponse.json(await importPurchaseHistory(buffer, { withCode }));
  });
}
