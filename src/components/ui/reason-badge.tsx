"use client";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { classifyModelError, type RuleSeverity } from "@/lib/rules/catalog-defaults";
import { useRuleMap, type RuleCatalogEntry } from "@/lib/rules/use-rule-catalog";

type Tone = "neutral" | "info" | "success" | "warning" | "danger";

/** 严重度 → badge 配色，与 RiskBadge 口径一致。 */
export const severityTone: Record<RuleSeverity, Tone> = {
  low: "neutral",
  medium: "warning",
  high: "danger",
};

export const severityLabel: Record<RuleSeverity, string> = {
  low: "低",
  medium: "中",
  high: "高",
};

/** 悬浮提示文本：中文名 + 说明 + 处理建议（换行展开），兜底显示未登记的原始码。 */
function tooltip(entry: RuleCatalogEntry | undefined, code: string): string {
  if (!entry) return `${code}（未登记规则）`;
  const parts = [entry.label];
  if (entry.description) parts.push(entry.description);
  if (entry.suggestion) parts.push(`建议：${entry.suggestion}`);
  return parts.join("\n");
}

function Chip({ entry, code, className }: { entry?: RuleCatalogEntry; code: string; className?: string }) {
  const tone: Tone = entry ? severityTone[entry.severity] : "neutral";
  return (
    <span title={tooltip(entry, code)} className={cn("cursor-help", className)}>
      <Badge tone={tone}>{entry?.label ?? code}</Badge>
    </span>
  );
}

/** 单个原因码 → 中文释义 badge（hover 出说明/建议）。 */
export function ReasonBadge({ code, className }: { code: string; className?: string }) {
  const { map } = useRuleMap();
  return <Chip entry={map.get(code)} code={code} className={className} />;
}

/**
 * 一组原因码 → 中文释义 badge 列表。
 * 被运营在后台「停用」的规则视为非问题，从列表中隐藏；全部为空时显示 emptyText。
 */
export function ReasonList({
  codes,
  emptyText = "无",
  className,
}: {
  codes: string[];
  emptyText?: string;
  className?: string;
}) {
  const { map } = useRuleMap();
  const visible = codes.filter((code) => map.get(code)?.enabled !== false);
  if (!visible.length) return <span className="text-muted-foreground">{emptyText}</span>;
  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {visible.map((code) => (
        <Chip key={code} entry={map.get(code)} code={code} />
      ))}
    </div>
  );
}

/**
 * 模型/接口异常的友好化呈现：把原始错误字符串归类成中文释义 badge，
 * 并用 <details> 折叠保留可排查的原始报错原文。无错误时回落显示 status。
 */
export function ModelErrorNote({
  error,
  status,
  align = "right",
}: {
  error?: string | null;
  status?: string | null;
  align?: "left" | "right";
}) {
  const { map } = useRuleMap();
  const text = String(error ?? "").trim();
  if (!text) {
    return <span className="text-xs text-muted-foreground">{status ?? "—"}</span>;
  }
  const code = classifyModelError(text);
  const entry = map.get(code);
  return (
    <div className={cn("flex flex-col gap-1", align === "right" ? "items-end" : "items-start")}>
      <span title={tooltip(entry, code)} className="cursor-help">
        <Badge tone={entry ? severityTone[entry.severity] : "danger"}>{entry?.label ?? "识别失败"}</Badge>
      </span>
      {entry?.suggestion ? (
        <span className="max-w-60 text-[11px] text-muted-foreground">{entry.suggestion}</span>
      ) : null}
      <details className="max-w-60 text-[11px] text-muted-foreground">
        <summary className="cursor-pointer select-none hover:text-foreground">原始错误</summary>
        <p className="mt-1 break-words rounded bg-muted px-2 py-1 font-mono text-[10px] leading-relaxed text-foreground/80">
          {text}
        </p>
      </details>
    </div>
  );
}
