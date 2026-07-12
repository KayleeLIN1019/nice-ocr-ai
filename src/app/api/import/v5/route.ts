import { NextResponse } from "next/server";
import { importLegacyRecognitionRows, type LegacyRecognitionRow } from "@/lib/workflows/import-v5";
import { badRequest, handleRoute } from "@/lib/api/http";

export const runtime = "nodejs";

/**
 * 编码健壮解码：剥离 UTF-8 BOM，先按 UTF-8 严格解码；失败则按 GB18030 回退，
 * 兼容旧版中文文件（GBK/GB2312），避免中文乱码。
 */
function decodeText(buffer: ArrayBuffer): string {
  let bytes = new Uint8Array(buffer);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    bytes = bytes.subarray(3);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder("gb18030").decode(bytes);
    } catch {
      return new TextDecoder("utf-8").decode(bytes);
    }
  }
}

async function readJsonArray(formData: FormData, key: string) {
  const file = formData.get(key);
  if (!(file instanceof File)) return [];
  const text = decodeText(await file.arrayBuffer());
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw badRequest(`${key} 不是合法 JSON`);
  }
  if (!Array.isArray(parsed)) {
    throw badRequest(`${key} 必须是 JSON 数组`);
  }
  return parsed;
}

export async function POST(request: Request) {
  return handleRoute(async () => {
    const formData = await request.formData();
    const rows = (await readJsonArray(formData, "recognitionResults")) as LegacyRecognitionRow[];
    return NextResponse.json(await importLegacyRecognitionRows(rows));
  });
}
