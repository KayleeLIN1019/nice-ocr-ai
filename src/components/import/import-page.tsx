"use client";

import { FileJson, UploadCloud } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Panel, PanelHeader, PanelTitle } from "@/components/ui/card";
import { apiUpload } from "@/lib/api/client";
import { apiPaths } from "@/lib/api/paths";

interface ImportResult {
  batch?: { id: string; name: string };
  documents: number;
  rows: number;
}

export function ImportPage() {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);

  const importMutation = useMutation<ImportResult, Error, File>({
    mutationFn: async (selected) => {
      const formData = new FormData();
      formData.append("recognitionResults", selected);
      return apiUpload<ImportResult>(apiPaths.importV5, formData);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["batches"] });
      queryClient.invalidateQueries({ queryKey: ["rows"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (err) => setError(err.message),
  });

  function pick(selected: File | null) {
    setError(null);
    setFile(selected);
    importMutation.reset();
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">导入 v5 数据</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          导入历史 recognition-results.json，自动归一化为批次、文档与识别明细行。
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <Panel>
          <PanelHeader>
            <PanelTitle>recognition-results.json</PanelTitle>
          </PanelHeader>
          <div className="p-4">
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="flex w-full flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-muted px-5 py-10 text-center transition-colors hover:border-primary"
            >
              <FileJson size={26} className="text-primary" />
              <div className="text-sm font-medium">{file ? file.name : "点击选择 recognition-results.json"}</div>
              <div className="text-xs text-muted-foreground">
                {file ? `${(file.size / 1024).toFixed(1)} KB` : "JSON 数组格式"}
              </div>
            </button>
            <input
              ref={inputRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(event) => pick(event.target.files?.[0] ?? null)}
            />
            {error ? <p className="mt-3 text-sm text-danger-strong">{error}</p> : null}
          </div>
        </Panel>

        <Panel>
          <PanelHeader>
            <PanelTitle>导入结果</PanelTitle>
          </PanelHeader>
          <div className="space-y-3 p-4 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">导入批次</span>
              <span>{importMutation.data?.batch?.name ?? "-"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">文档数</span>
              <span>{importMutation.data?.documents ?? 0}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">识别行</span>
              <span>{importMutation.data?.rows ?? 0}</span>
            </div>
            <Button
              className="mt-3 w-full"
              variant="primary"
              onClick={() => file && importMutation.mutate(file)}
              disabled={!file || importMutation.isPending}
            >
              <UploadCloud size={15} />
              {importMutation.isPending ? "导入中..." : "开始导入"}
            </Button>
            {importMutation.isSuccess ? (
              <p className="text-xs text-success-strong">导入成功，可前往全部结果或仪表盘查看。</p>
            ) : null}
          </div>
        </Panel>
      </div>
    </div>
  );
}
