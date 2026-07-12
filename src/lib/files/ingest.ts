import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { unzipSync } from "fflate";
import { pdf } from "pdf-to-img";

/**
 * 上传文件解析：把图片 / PDF / ZIP 统一展开为「可识别图片」列表。
 * 下游（存储 / Document / 识别 / 预览）一律按图片处理，无需感知原始格式。
 */
/** 展开后图片的来源类别。 */
export type IngestSourceKind = "image" | "pdf" | "zip-image" | "zip-pdf";

/**
 * 来源溯源元数据：随每张展开图片一路带到 Document，供前端"前缀标识 + 看具体来源"。
 * 结构化承载，绝不靠文件名反推。
 */
export interface IngestSource {
  kind: IngestSourceKind;
  /** 顶层上传文件名（发票.pdf / 档案.zip / 单张.jpg）。 */
  uploadName: string;
  /** ZIP 内条目路径（zip-image / zip-pdf 才有）。 */
  entryPath?: string;
  /** PDF / zip 内 PDF 的 1-based 页码。 */
  pageNumber?: number;
  /** 该 PDF 的总页数。 */
  pageCount?: number;
}

export interface IngestedImage {
  /** 展开后的文件名（用于 Document.originalName 与存储扩展名） */
  name: string;
  buffer: Buffer;
  mimeType: string;
  /** 来源溯源。 */
  source: IngestSource;
}

export interface IngestOptions {
  pdfRenderScale?: number;
}

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|bmp|tiff?)$/i;

/**
 * PDF 渲染倍率（pdfjs 按 72DPI × scale 栅格化，输出 PNG 无损）。
 * PDF 是矢量/页面描述，转图片必然要栅格化，无法真正 100% 无损；倍率越高越逼近无损。
 * 默认 4（≈288DPI），偏「尽量无损」；设置页可调到 1..6。
 * 倍率越高越清晰，但单页内存 / 渲染耗时 / 磁盘占用随之上升。
 */
const DEFAULT_PDF_RENDER_SCALE = 4;

function normalizePdfRenderScale(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_PDF_RENDER_SCALE;
  return Math.min(6, Math.max(1, parsed));
}

function baseName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath;
}

function stripExt(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}

function imageMime(name: string): string {
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  switch (ext) {
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "bmp":
      return "image/bmp";
    case "tif":
    case "tiff":
      return "image/tiff";
    default:
      return "image/jpeg";
  }
}

function isImage(name: string, mime?: string): boolean {
  return IMAGE_EXT.test(name) || Boolean(mime && mime.startsWith("image/"));
}

function isPdf(name: string, mime?: string): boolean {
  return /\.pdf$/i.test(name) || mime === "application/pdf";
}

function isZip(name: string, mime?: string): boolean {
  return (
    /\.zip$/i.test(name) ||
    mime === "application/zip" ||
    mime === "application/x-zip-compressed" ||
    mime === "multipart/x-zip"
  );
}

interface PdfAssetUrls {
  standardFontDataUrl: string;
  cMapUrl: string;
  cMapPacked: true;
}

/**
 * 解析 pdfjs 标准字体 / CMap 资源目录（CMap 影响中文等 CJK 文字的 PDF 渲染，字体影响标准字体文字）。
 * Node 字体工厂用 fs.readFile 读取，故传**正斜杠 + 尾随 `/`** 的文件系统路径（pdfjs 校验要求结尾为 `/`）。
 * 仅解析一次并缓存；失败则降级为不传（扫描件 PDF 不受影响）。
 */
let cachedAssets: PdfAssetUrls | null | undefined;
function pdfAssetUrls(): PdfAssetUrls | undefined {
  if (cachedAssets !== undefined) return cachedAssets ?? undefined;
  try {
    const require = createRequire(path.join(process.cwd(), "package.json"));
    let dir = path.dirname(require.resolve("pdfjs-dist"));
    for (let i = 0; i < 5; i += 1) {
      if (fs.existsSync(path.join(dir, "standard_fonts"))) {
        const toUrl = (sub: string) => path.join(dir, sub).replace(/\\/g, "/") + "/";
        cachedAssets = {
          standardFontDataUrl: toUrl("standard_fonts"),
          cMapUrl: toUrl("cmaps"),
          cMapPacked: true,
        };
        return cachedAssets;
      }
      dir = path.dirname(dir);
    }
  } catch {
    /* 解析失败则降级 */
  }
  cachedAssets = null;
  return undefined;
}

/**
 * 把 PDF 每页渲染为 PNG，逐页 yield（不在内存累积所有页）。
 * `displayName` 用于派生页文件名；`source` 是这份 PDF 的基础来源（pdf / zip-pdf），
 * 每页在其上补 pageNumber/pageCount。总页数取 pdf-to-img 的 `Pdf.length`。
 */
async function* renderPdfPages(
  displayName: string,
  buffer: Buffer,
  source: { kind: "pdf" | "zip-pdf"; uploadName: string; entryPath?: string },
  options: IngestOptions = {},
): AsyncGenerator<IngestedImage> {
  const doc = await pdf(new Uint8Array(buffer), {
    scale: normalizePdfRenderScale(options.pdfRenderScale),
    docInitParams: pdfAssetUrls(),
  });
  const pageCount = doc.length;
  let index = 0;
  for await (const page of doc) {
    index += 1;
    yield {
      name: `${stripExt(baseName(displayName))}-p${index}.png`,
      buffer: Buffer.from(page),
      mimeType: "image/png",
      source: { ...source, pageNumber: index, pageCount },
    };
  }
}

/**
 * 把一个上传文件流式展开为可识别图片，逐个 yield：
 * - 图片：原样透传
 * - PDF：每页渲染成 PNG（逐页 yield）
 * - ZIP：解压，对其中图片/PDF 处理（忽略目录、隐藏项、__MACOSX 及其它格式）
 * 调用方可边拿边持久化，峰值内存仅一张图——避免把整本 PDF / 整个 ZIP 的渲染结果一次性堆在内存。
 * 不支持的单文件不产出任何条目，调用方据此提示。
 */
export async function* ingestUploadStream(
  name: string,
  buffer: Buffer,
  mimeType?: string,
  options: IngestOptions = {},
): AsyncGenerator<IngestedImage> {
  if (isZip(name, mimeType)) {
    const entries = unzipSync(new Uint8Array(buffer));
    for (const [entryPath, data] of Object.entries(entries)) {
      if (entryPath.endsWith("/")) continue; // 目录项
      const base = baseName(entryPath);
      if (!base || base.startsWith(".") || entryPath.startsWith("__MACOSX")) continue;
      const buf = Buffer.from(data);
      if (isImage(base)) {
        yield {
          name: base,
          buffer: buf,
          mimeType: imageMime(base),
          source: { kind: "zip-image", uploadName: name, entryPath },
        };
      } else if (isPdf(base)) {
        // ZIP 内嵌 PDF：保留压缩包名 + 内部条目路径 + 页码。
        yield* renderPdfPages(base, buf, { kind: "zip-pdf", uploadName: name, entryPath }, options);
      }
    }
    return;
  }

  if (isPdf(name, mimeType)) {
    yield* renderPdfPages(name, buffer, { kind: "pdf", uploadName: name }, options);
    return;
  }

  if (isImage(name, mimeType)) {
    yield {
      name,
      buffer,
      mimeType: mimeType?.startsWith("image/") ? mimeType : imageMime(name),
      source: { kind: "image", uploadName: name },
    };
  }
}

/** 收集为数组的便捷封装（保留旧用法）。新代码优先用 ingestUploadStream 以控内存。 */
export async function ingestUpload(
  name: string,
  buffer: Buffer,
  mimeType?: string,
  options: IngestOptions = {},
): Promise<IngestedImage[]> {
  const images: IngestedImage[] = [];
  for await (const image of ingestUploadStream(name, buffer, mimeType, options)) {
    images.push(image);
  }
  return images;
}
