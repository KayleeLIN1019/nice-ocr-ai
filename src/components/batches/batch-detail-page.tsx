"use client";

import Link from "next/link";
import { CheckCircle2, ChevronLeft, Eye, ImageOff, RotateCcw, UploadCloud } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Panel, PanelHeader, PanelTitle } from "@/components/ui/card";
import { DocStatusBadge, RiskBadge } from "@/components/ui/status";
import { SourceBadge } from "@/components/ui/source-badge";
import { DataTable, tableCellClass, tableHeadClass, TableWrap } from "@/components/ui/table";
import { ExportMenu } from "@/components/results/export-menu";
import { BatchWorkspaceNav } from "@/components/batches/batch-workspace-nav";
import { cn, formatDateTime } from "@/lib/utils";
import { apiGet, apiJson, apiUpload } from "@/lib/api/client";
import { apiPaths } from "@/lib/api/paths";
import type { RiskLevel } from "@/lib/types";

interface ApiDoc {
  id: string;
  originalName: string;
  status: string;
  riskLevel: RiskLevel;
  storedPath: string;
  updatedAt: string;
  sourceType: string;
  sourceFile?: string | null;
  sourceEntry?: string | null;
  pageNumber?: number | null;
  pageCount?: number | null;
}

interface BatchDetail {
  batch: {
    id: string;
    name: string;
    status: string;
    closedAt?: string | null;
    exportTemplateId?: string | null;
    scenarioId?: string | null;
    documents: ApiDoc[];
    _count: { documents: number; rows: number };
  };
}

export function BatchDetailPage({ batchId }: { batchId: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [override, setOverride] = useState<string | null>(null);

  const { data, isLoading } = useQuery<BatchDetail>({
    queryKey: ["batch", batchId],
    queryFn: () => apiGet(apiPaths.batch(batchId)),
    // 有文档仍在排队/识别中时轮询刷新，让文件状态实时变化（排队→识别中→已识别）。
    refetchInterval: (query) => {
      const docs = query.state.data?.batch.documents ?? [];
      const active = docs.some((doc) => doc.status === "queued" || doc.status === "processing");
      return active ? 3000 : false;
    },
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["batch", batchId] });
    queryClient.invalidateQueries({ queryKey: ["batches"] });
    queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  };

  const uploadFiles = useMutation({
    mutationFn: (files: File[]) => {
      const formData = new FormData();
      files.forEach((file) => formData.append("files", file));
      return apiUpload(apiPaths.batchUpload(batchId), formData);
    },
    onSuccess: invalidate,
  });
  const retry = useMutation({
    mutationFn: (documentId: string) => apiJson(apiPaths.documentRetry(documentId), { method: "POST" }),
    onSuccess: invalidate,
  });
  // 封批/撤销：写入或清除 closedAt（审核收口标记）。
  const toggleClose = useMutation({
    mutationFn: (closed: boolean) => apiJson(apiPaths.batch(batchId), { method: "PATCH", body: JSON.stringify({ closed }) }),
    onSuccess: invalidate,
  });

  const batch = data?.batch;
  const documents = batch?.documents ?? [];
  const selectedId = override ?? documents[0]?.id ?? null;
  const selected = documents.find((doc) => doc.id === selectedId) ?? null;
  const reviewHref = (documentId: string) => `/review?batchId=${batchId}&documentId=${documentId}`;
  const openReview = (documentId: string) => router.push(reviewHref(documentId));

  return (
    <div className="space-y-4">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/*,application/pdf,.pdf,.zip,application/zip"
        className="hidden"
        onChange={(event) => {
          // 同步快照成 File[]，再清空 input；否则异步 mutation 读到的是被 value="" 清空的空 FileList。
          const files = event.target.files ? Array.from(event.target.files) : [];
          event.target.value = "";
          if (files.length) uploadFiles.mutate(files);
        }}
      />

      <BatchWorkspaceNav batchId={batchId} active="overview" />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link href="/batches" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary">
          <ChevronLeft size={14} />
          返回批次列表
        </Link>
        <div className="flex flex-col items-end gap-1">
          <div className="flex items-center gap-2">
            {batch?.closedAt ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => toggleClose.mutate(false)}
                disabled={toggleClose.isPending}
                title={`已封批 ${formatDateTime(batch.closedAt)} · 点击撤销`}
              >
                <CheckCircle2 size={15} className="text-success-strong" />已封批 · 撤销
              </Button>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => toggleClose.mutate(true)}
                disabled={toggleClose.isPending || !documents.length}
                title="标记本批次审核完成（收口）"
              >
                <CheckCircle2 size={15} />标记完成审核
              </Button>
            )}
            <ExportMenu scope={{ batchId }} defaultTemplateId={batch?.exportTemplateId} />
            <Button size="sm" variant="primary" onClick={() => fileInputRef.current?.click()} disabled={uploadFiles.isPending}>
              <UploadCloud size={15} />{uploadFiles.isPending ? "上传解析中..." : "上传文件"}
            </Button>
          </div>
          {uploadFiles.isError ? (
            <span className="text-xs text-danger">{(uploadFiles.error as Error)?.message ?? "上传失败"}</span>
          ) : (
            <span className="text-[11px] text-muted-foreground">支持 图片 / PDF / ZIP</span>
          )}
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
        <TableWrap className="min-h-[560px]">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div className="text-sm font-semibold">文件列表</div>
            <div className="text-xs text-muted-foreground">
              {batch ? `${batch._count.documents} 文档 / ${batch._count.rows} 行` : ""}
            </div>
          </div>
          <DataTable>
            <thead className={tableHeadClass}>
              <tr>
                <th className={tableCellClass}>文件名</th>
                <th className={tableCellClass}>来源</th>
                <th className={tableCellClass}>状态</th>
                <th className={tableCellClass}>风险</th>
                <th className={tableCellClass}>更新时间</th>
                <th className={tableCellClass}>操作</th>
              </tr>
            </thead>
            <tbody>
              {documents.length ? (
                documents.map((doc) => {
                  const retryDisabled = retry.isPending || doc.status === "queued" || doc.status === "processing";
                  return (
                    <tr
                      key={doc.id}
                      className={`cursor-pointer hover:bg-muted/70 ${doc.id === selectedId ? "bg-muted/50" : ""}`}
                      onClick={() => openReview(doc.id)}
                      title="查看原图并审核修改识别明细"
                    >
                      <td className={tableCellClass}>
                        <Link
                          href={reviewHref(doc.id)}
                          onClick={(event) => event.stopPropagation()}
                          className="inline-flex max-w-[260px] items-center gap-1.5 truncate font-medium text-primary hover:underline"
                          title="查看原图并审核修改识别明细"
                        >
                          <Eye size={14} className="shrink-0" />
                          <span className="truncate">{doc.originalName}</span>
                        </Link>
                      </td>
                      <td className={cn(tableCellClass, "max-w-[200px]")}>
                        <SourceBadge source={doc} />
                      </td>
                      <td className={tableCellClass}><DocStatusBadge status={doc.status} /></td>
                      <td className={tableCellClass}><RiskBadge risk={doc.riskLevel} /></td>
                      <td className={tableCellClass}>{formatDateTime(doc.updatedAt)}</td>
                      <td className={tableCellClass}>
                        <div className="flex gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={(event) => {
                              event.stopPropagation();
                              setOverride(doc.id);
                            }}
                            title="在右侧预览此文件"
                          >
                            预览
                          </Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={(event) => {
                              event.stopPropagation();
                              retry.mutate(doc.id);
                            }}
                            disabled={retryDisabled}
                            title={retryDisabled ? "文档已在队列中或正在处理" : "重新加入识别队列"}
                          >
                            <RotateCcw size={14} />重试
                          </Button>
                          <Button size="sm" variant="ghost" asChild>
                            <Link
                              href={reviewHref(doc.id)}
                              onClick={(event) => event.stopPropagation()}
                              title="查看原图并审核修改识别明细"
                            >
                              <Eye size={14} />查看/审核
                            </Link>
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td className={tableCellClass} colSpan={6}>
                    <span className="text-muted-foreground">{isLoading ? "加载中..." : "暂无文档，请上传文件"}</span>
                  </td>
                </tr>
              )}
            </tbody>
          </DataTable>
        </TableWrap>

        <Panel>
          <PanelHeader>
            <PanelTitle>{selected?.originalName ?? "单据预览"}</PanelTitle>
          </PanelHeader>
          <div className="p-4">
            <div className="flex h-56 items-center justify-center overflow-hidden rounded-md border border-border bg-muted">
              {selected?.storedPath ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={selected.id}
                  src={apiPaths.documentImage(selected.id)}
                  alt={selected.originalName}
                  className="max-h-full max-w-full object-contain"
                />
              ) : (
                <div className="flex flex-col items-center gap-2 text-muted-foreground">
                  <ImageOff size={24} />
                  <span className="text-xs">原图不可用</span>
                </div>
              )}
            </div>
            {selected ? (
              <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
                <div className="col-span-2">
                  <dt className="text-xs text-muted-foreground">来源</dt>
                  <dd className="mt-1"><SourceBadge source={selected} /></dd>
                </div>
                {selected.sourceFile ? (
                  <div className="col-span-2">
                    <dt className="text-xs text-muted-foreground">原始文件</dt>
                    <dd className="mt-1 break-all">
                      {selected.sourceFile}
                      {selected.sourceEntry ? <span className="text-muted-foreground"> › {selected.sourceEntry}</span> : null}
                    </dd>
                  </div>
                ) : null}
                <div><dt className="text-xs text-muted-foreground">状态</dt><dd className="mt-1"><DocStatusBadge status={selected.status} /></dd></div>
                <div><dt className="text-xs text-muted-foreground">风险等级</dt><dd className="mt-1"><RiskBadge risk={selected.riskLevel} /></dd></div>
                <div><dt className="text-xs text-muted-foreground">更新时间</dt><dd className="mt-1">{formatDateTime(selected.updatedAt)}</dd></div>
                <div className="col-span-2">
                  <Button size="sm" variant="primary" asChild>
                    <Link href={reviewHref(selected.id)}>
                      <Eye size={15} />查看/审核修改
                    </Link>
                  </Button>
                </div>
              </dl>
            ) : null}
          </div>
        </Panel>
      </div>
    </div>
  );
}
