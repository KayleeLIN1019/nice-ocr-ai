import { NextResponse } from "next/server";
import { enqueueRecognitionJob } from "@/lib/queue/jobs";
import { prisma } from "@/lib/db/client";
import { storeOriginal } from "@/lib/files/storage";
import { ingestUploadStream } from "@/lib/files/ingest";
import { enforceRateLimit } from "@/lib/ratelimit";
import { getRecognitionDefaults } from "@/lib/recognition/settings";

export const runtime = "nodejs";
// PDF 逐页渲染较耗时，放宽函数执行时长上限。
export const maxDuration = 300;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const limited = enforceRateLimit(request, "upload", 20, 60_000);
  if (limited) return limited;

  const { id: batchId } = await params;
  const defaults = await getRecognitionDefaults();
  const formData = await request.formData();
  const files = formData.getAll("files").filter((item): item is File => item instanceof File);

  if (!files.length) {
    return NextResponse.json({ error: "No files uploaded" }, { status: 400 });
  }

  // 逐文件流式展开并立即持久化：图片原样、PDF 逐页、ZIP 逐条；峰值内存仅一张图，
  // 不把所有渲染结果堆在内存。单文件解析失败只跳过并记录，不影响已成功的其它文件。
  const created = [];
  const failed = [];
  for (const file of files) {
    const buffer = Buffer.from(await file.arrayBuffer());
    try {
      for await (const image of ingestUploadStream(file.name, buffer, file.type, {
        pdfRenderScale: defaults.pdfRenderScale,
      })) {
        const { hash, storedPath } = await storeOriginal(batchId, image.name, image.buffer);
        const document = await prisma.document.create({
          data: {
            batchId,
            originalName: image.name,
            storedPath,
            hash,
            mimeType: image.mimeType || "image/png",
            sizeBytes: image.buffer.byteLength,
            status: "queued",
            // 来源溯源：结构化落库，供前端来源徽章与"看具体来源"。
            sourceType: image.source.kind,
            sourceFile: image.source.uploadName,
            sourceEntry: image.source.entryPath ?? null,
            pageNumber: image.source.pageNumber ?? null,
            pageCount: image.source.pageCount ?? null,
          },
        });
        await enqueueRecognitionJob(document.id, batchId);
        created.push(document);
      }
    } catch (error) {
      failed.push({ name: file.name, error: error instanceof Error ? error.message : String(error) });
    }
  }

  if (!created.length) {
    const detail = failed.length
      ? failed.map((item) => `「${item.name}」：${item.error}`).join("；")
      : "未找到可识别内容。支持：图片（jpg/png/webp 等）、PDF、或包含上述文件的 ZIP 压缩包。";
    return NextResponse.json({ error: detail }, { status: 400 });
  }

  await prisma.batch.update({
    where: { id: batchId },
    data: { status: "processing" },
  });

  return NextResponse.json(
    { documents: created, queuedJobs: created.length, failed },
    { status: 201 },
  );
}
