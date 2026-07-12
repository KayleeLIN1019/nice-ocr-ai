"use client";

import { ChevronDown, Download, FilePlus2, FileSpreadsheet } from "lucide-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { apiDownload, apiGet } from "@/lib/api/client";
import { apiPaths } from "@/lib/api/paths";
import type { ExportScope } from "@/lib/workflows/exports";

interface ExportTemplateInfo {
  id: string;
  name: string;
  description: string;
}

/** 去掉空字符串/空数组字段，只保留生效的范围条件。 */
function normalizeScope(scope?: ExportScope): ExportScope | undefined {
  if (!scope) return undefined;
  const entries = Object.entries(scope).filter(([, value]) =>
    Array.isArray(value) ? value.length > 0 : Boolean(value),
  );
  return entries.length ? (Object.fromEntries(entries) as ExportScope) : undefined;
}

/**
 * 导出按钮。
 * - `scope`：选择性导出范围（按批次/当前筛选）；缺省=全库。
 * - `defaultTemplateId`：批次绑定的导出模板；存在时主按钮一键直出该模板，多模板仍可下拉切换。
 * - 「追加」：上传一份已有的同模板 xlsx，把当前范围的新数据并入后下载（mode=append）。
 */
export function ExportMenu({
  scope,
  defaultTemplateId,
}: { scope?: ExportScope; defaultTemplateId?: string | null } = {}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingAppendRef = useRef<string | null>(null);

  const { data } = useQuery<{ templates: ExportTemplateInfo[] }>({
    queryKey: ["export-templates"],
    queryFn: () => apiGet(apiPaths.exportsTemplates),
    staleTime: 10 * 60 * 1000,
  });
  const templates = data?.templates ?? [];
  const multiple = templates.length > 1;
  const activeScope = normalizeScope(scope);
  const scoped = Boolean(activeScope);
  const boundTemplate = defaultTemplateId ? templates.find((template) => template.id === defaultTemplateId) : undefined;

  const exportRows = useMutation({
    mutationFn: (templateId?: string) =>
      apiDownload(apiPaths.exportsRecognition, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(templateId ? { templateId } : {}),
          ...(activeScope ? { scope: activeScope } : {}),
        }),
      }),
    onSettled: () => setOpen(false),
  });

  const appendRows = useMutation({
    mutationFn: ({ templateId, file }: { templateId: string; file: File }) => {
      const formData = new FormData();
      formData.append("baseFile", file);
      formData.append("meta", JSON.stringify({ templateId, mode: "append", ...(activeScope ? { scope: activeScope } : {}) }));
      // 不手动设 content-type：浏览器会带上 multipart 边界。
      return apiDownload(apiPaths.exportsRecognition, { method: "POST", body: formData });
    },
    onSettled: () => setOpen(false),
  });

  const pending = exportRows.isPending || appendRows.isPending;

  function startAppend(templateId: string) {
    pendingAppendRef.current = templateId;
    fileInputRef.current?.click();
  }

  function onFileChosen(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    const templateId = pendingAppendRef.current;
    event.target.value = "";
    pendingAppendRef.current = null;
    if (file && templateId) appendRows.mutate({ templateId, file });
  }

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const label = exportRows.isPending ? "导出中…" : appendRows.isPending ? "追加中…" : "导出";

  const hiddenInput = (
    <input
      ref={fileInputRef}
      type="file"
      accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      className="hidden"
      onChange={onFileChosen}
    />
  );

  // 单模板、或已绑定模板：主按钮一键直出；附带「追加」与（多模板时）下拉切换。
  if (!multiple || boundTemplate) {
    const directId = boundTemplate?.id;
    return (
      <div ref={containerRef} className="relative inline-flex items-center gap-1">
        {hiddenInput}
        <Button
          size="sm"
          variant="primary"
          onClick={() => exportRows.mutate(directId)}
          disabled={pending}
          title={boundTemplate ? `按绑定模板「${boundTemplate.name}」导出` : undefined}
        >
          <Download size={15} />
          {label}
          {boundTemplate ? <span className="max-w-32 truncate text-xs opacity-90">· {boundTemplate.name}</span> : null}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => startAppend(directId ?? templates[0]?.id ?? "")}
          disabled={pending || templates.length === 0}
          title="上传已有 Excel，把当前范围的新数据追加进去"
        >
          <FilePlus2 size={15} />
          追加
        </Button>
        {multiple ? (
          <>
            <Button
              size="icon"
              variant="secondary"
              aria-label="切换导出模板"
              aria-haspopup="menu"
              aria-expanded={open}
              onClick={() => setOpen((value) => !value)}
              disabled={pending}
            >
              <ChevronDown size={14} />
            </Button>
            {open ? (
              <TemplateMenu templates={templates} scoped={scoped} pending={pending} onExport={(id) => exportRows.mutate(id)} onAppend={startAppend} />
            ) : null}
          </>
        ) : null}
      </div>
    );
  }

  // 多模板、未绑定：导出按钮 + 模板选择下拉（每个模板可导出或追加）。
  return (
    <div ref={containerRef} className="relative">
      {hiddenInput}
      <Button
        size="sm"
        variant="primary"
        onClick={() => setOpen((value) => !value)}
        disabled={pending}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Download size={15} />
        {label}
        <ChevronDown size={14} />
      </Button>
      {open ? (
        <TemplateMenu templates={templates} scoped={scoped} pending={pending} onExport={(id) => exportRows.mutate(id)} onAppend={startAppend} />
      ) : null}
    </div>
  );
}

function TemplateMenu({
  templates,
  scoped,
  pending,
  onExport,
  onAppend,
}: {
  templates: ExportTemplateInfo[];
  scoped: boolean;
  pending: boolean;
  onExport: (id: string) => void;
  onAppend: (id: string) => void;
}) {
  return (
    <div role="menu" className="absolute right-0 z-20 mt-1 w-80 rounded-lg border border-border bg-surface p-1 shadow-lg">
      <div className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">选择导出模板</div>
      <div className="px-2 pb-1.5 text-xs text-muted-foreground">{scoped ? "导出范围：当前筛选 / 批次" : "导出范围：全部结果"}</div>
      {templates.map((template) => (
        <div key={template.id} className="flex items-stretch gap-1 rounded-md hover:bg-muted">
          <button
            role="menuitem"
            onClick={() => onExport(template.id)}
            disabled={pending}
            className="flex min-w-0 flex-1 items-start gap-2 rounded-md px-2 py-2 text-left disabled:opacity-50"
          >
            <FileSpreadsheet size={16} className="mt-0.5 shrink-0 text-primary" />
            <span className="min-w-0">
              <span className="block text-sm font-medium text-foreground">{template.name}</span>
              <span className="block text-xs text-muted-foreground">{template.description}</span>
            </span>
          </button>
          <button
            aria-label={`追加到已有「${template.name}」文件`}
            title="上传已有 Excel 追加"
            onClick={() => onAppend(template.id)}
            disabled={pending}
            className="flex shrink-0 items-center rounded-md px-2 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
          >
            <FilePlus2 size={16} />
          </button>
        </div>
      ))}
    </div>
  );
}
