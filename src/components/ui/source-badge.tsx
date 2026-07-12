import { FileArchive, FileText, Image as ImageIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/** 文档来源溯源信息（对应 Document 的 source* 字段）。 */
export interface DocumentSource {
  sourceType: string;
  sourceFile?: string | null;
  sourceEntry?: string | null;
  pageNumber?: number | null;
  pageCount?: number | null;
}

/** 取路径末段（zip 内条目路径常含目录，列表只展示文件名，完整路径放 title）。 */
function lastSegment(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || path;
}

function pageLabel(source: DocumentSource): string {
  if (!source.pageNumber) return "";
  return source.pageCount ? ` · 第${source.pageNumber}/${source.pageCount}页` : ` · 第${source.pageNumber}页`;
}

/**
 * 来源徽章：按 sourceType 渲染图标 + 文案，让"前缀标识 + 看具体来源"一眼可辨。
 * compact 用于队列页等空间紧凑处，仅显示类型与页码；完整来源放 title 悬浮。
 */
export function SourceBadge({
  source,
  compact = false,
  className,
}: {
  source: DocumentSource;
  compact?: boolean;
  className?: string;
}) {
  const { sourceType, sourceFile, sourceEntry } = source;

  let Icon = ImageIcon;
  let tone: "neutral" | "info" = "neutral";
  let label = "图片";
  let title = "直接上传的图片";

  if (sourceType === "pdf") {
    Icon = FileText;
    tone = "info";
    const file = sourceFile ?? "PDF";
    label = compact ? `PDF${pageLabel(source)}` : `PDF · ${file}${pageLabel(source)}`;
    title = `PDF：${file}${pageLabel(source)}`;
  } else if (sourceType === "zip-image") {
    Icon = FileArchive;
    tone = "neutral";
    const entry = sourceEntry ?? "";
    label = compact ? "ZIP" : `ZIP · ${entry ? lastSegment(entry) : sourceFile ?? ""}`;
    title = `ZIP：${sourceFile ?? ""}${entry ? ` › ${entry}` : ""}`;
  } else if (sourceType === "zip-pdf") {
    Icon = FileArchive;
    tone = "info";
    const entry = sourceEntry ?? "";
    const inner = entry ? lastSegment(entry) : "PDF";
    label = compact ? `ZIP›PDF${pageLabel(source)}` : `ZIP›PDF · ${inner}${pageLabel(source)}`;
    title = `ZIP：${sourceFile ?? ""}${entry ? ` › ${entry}` : ""}${pageLabel(source)}`;
  }

  return (
    <Badge tone={tone} title={title} className={cn("max-w-full gap-1", className)}>
      <Icon size={12} className="shrink-0" />
      <span className="truncate">{label}</span>
    </Badge>
  );
}
