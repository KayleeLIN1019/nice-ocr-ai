"use client";

import Link from "next/link";
import { Ban, RefreshCw, RotateCcw } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { JobStatusBadge } from "@/components/ui/status";
import { SourceBadge, type DocumentSource } from "@/components/ui/source-badge";
import { DataTable, tableCellClass, tableHeadClass, TableWrap } from "@/components/ui/table";
import { Pagination } from "@/components/ui/pagination";
import { cn, formatDateTime } from "@/lib/utils";
import { apiGet, apiJson } from "@/lib/api/client";
import { apiPaths } from "@/lib/api/paths";
import type { JobStatus } from "@/lib/types";

interface QueueJob {
  id: string;
  type: string;
  status: JobStatus;
  attemptsMade: number;
  maxAttempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  document: ({ id: string; originalName: string; status: string } & DocumentSource) | null;
  batch: { id: string; name: string } | null;
}

interface QueueResponse {
  jobs: QueueJob[];
  total: number;
  page: number;
  pageSize: number;
  counts: Record<string, number>;
}

const JOB_TYPE_LABELS: Record<string, string> = {
  extract: "识别",
  second_pass: "二次识别",
  consensus: "一致性校验",
  audit: "审核复查",
};

const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "全部状态" },
  { value: "queued", label: "排队" },
  { value: "active", label: "处理中" },
  { value: "failed", label: "失败" },
  { value: "completed", label: "成功" },
  { value: "cancelled", label: "已取消" },
];

const TYPE_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "全部类型" },
  { value: "extract", label: "识别" },
  { value: "second_pass", label: "二次识别" },
  { value: "consensus", label: "一致性校验" },
  { value: "audit", label: "审核复查" },
];

// 概览卡：各状态计数（颜色取自设计 token 的 *-soft 软底）。
const OVERVIEW: { key: string; label: string; className: string }[] = [
  { key: "queued", label: "排队中", className: "bg-muted text-muted-foreground" },
  { key: "active", label: "处理中", className: "bg-info-soft text-info-strong" },
  { key: "failed", label: "失败", className: "bg-danger-soft text-danger-strong" },
  { key: "completed", label: "已完成", className: "bg-success-soft text-success-strong" },
  { key: "cancelled", label: "已取消", className: "bg-muted text-muted-foreground" },
];

const PAGE_SIZE = 20;

export function QueuePage() {
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  // 支持从仪表盘等入口带 ?status= 深链进入队列并预置筛选。
  const [status, setStatus] = useState(searchParams.get("status") ?? "");
  const [type, setType] = useState("");
  const [page, setPage] = useState(1);

  const queryString = (() => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (status) params.set("status", status);
    if (type) params.set("type", type);
    return params.toString();
  })();

  const { data, isLoading, isFetching, refetch } = useQuery<QueueResponse>({
    queryKey: ["queue", queryString],
    queryFn: () => apiGet(`${apiPaths.queue}?${queryString}`),
    refetchInterval: 5000, // 自动刷新：worker 在后台推进作业，5s 轮询保持队列态最新。
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["queue"] });
    queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  };

  const retry = useMutation({
    mutationFn: (id: string) => apiJson(apiPaths.queueRetry(id), { method: "POST" }),
    onSuccess: invalidate,
  });
  const cancel = useMutation({
    mutationFn: (id: string) => apiJson(apiPaths.queueCancel(id), { method: "POST" }),
    onSuccess: invalidate,
  });
  const retryFailed = useMutation({
    mutationFn: () => apiJson(apiPaths.queueRetryFailed, { method: "POST", body: JSON.stringify({}) }),
    onSuccess: invalidate,
  });

  const jobs = data?.jobs ?? [];
  const counts = data?.counts ?? {};
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const failedCount = counts.failed ?? 0;
  const actionError =
    (retry.error as Error)?.message ??
    (cancel.error as Error)?.message ??
    (retryFailed.error as Error)?.message ??
    null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">识别队列</h1>
          <p className="mt-1 text-sm text-muted-foreground">查看并维护所有识别 / 审核作业的处理进度。</p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw size={14} className={cn(isFetching && "animate-spin")} />
            刷新
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => retryFailed.mutate()}
            disabled={retryFailed.isPending || failedCount === 0}
            title={failedCount === 0 ? "暂无失败作业" : undefined}
          >
            <RotateCcw size={14} />
            {retryFailed.isPending ? "重试中..." : `重试全部失败${failedCount ? ` (${failedCount})` : ""}`}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {OVERVIEW.map((item) => (
          <div key={item.key} className="rounded-lg border border-border bg-surface p-3">
            <div className="text-xs text-muted-foreground">{item.label}</div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-2xl font-semibold tabular-nums">{counts[item.key] ?? 0}</span>
              <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", item.className)}>
                {item.label}
              </span>
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface p-3">
        <select
          className="h-9 rounded-md border border-border bg-surface px-3 text-sm outline-none focus:border-primary"
          value={status}
          onChange={(event) => {
            setStatus(event.target.value);
            setPage(1);
          }}
        >
          {STATUS_FILTERS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <select
          className="h-9 rounded-md border border-border bg-surface px-3 text-sm outline-none focus:border-primary"
          value={type}
          onChange={(event) => {
            setType(event.target.value);
            setPage(1);
          }}
        >
          {TYPE_FILTERS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {actionError ? <span className="text-xs text-danger">{actionError}</span> : null}
      </div>

      <TableWrap>
        <DataTable>
          <thead className={tableHeadClass}>
            <tr>
              <th className={tableCellClass}>类型</th>
              <th className={tableCellClass}>状态</th>
              <th className={tableCellClass}>批次</th>
              <th className={tableCellClass}>文档</th>
              <th className={tableCellClass}>尝试</th>
              <th className={tableCellClass}>最近错误</th>
              <th className={tableCellClass}>入队时间</th>
              <th className={tableCellClass}>操作</th>
            </tr>
          </thead>
          <tbody>
            {jobs.length ? (
              jobs.map((job) => (
                <tr key={job.id} className="hover:bg-muted/60">
                  <td className={tableCellClass}>{JOB_TYPE_LABELS[job.type] ?? job.type}</td>
                  <td className={tableCellClass}>
                    <JobStatusBadge status={job.status} />
                  </td>
                  <td className={tableCellClass}>
                    {job.batch ? (
                      <Link href={`/batches/${job.batch.id}`} className="text-primary hover:underline">
                        {job.batch.name}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </td>
                  <td className={cn(tableCellClass, "max-w-[220px]")}>
                    <div className="flex flex-col gap-1">
                      <span className="truncate" title={job.document?.originalName}>
                        {job.document?.originalName ?? "-"}
                      </span>
                      {job.document ? <SourceBadge source={job.document} compact /> : null}
                    </div>
                  </td>
                  <td className={tableCellClass}>
                    <span className="tabular-nums">
                      {job.attemptsMade}/{job.maxAttempts}
                    </span>
                  </td>
                  <td className={cn(tableCellClass, "max-w-[260px] truncate text-danger")} title={job.lastError ?? undefined}>
                    {job.lastError ?? "-"}
                  </td>
                  <td className={cn(tableCellClass, "whitespace-nowrap text-muted-foreground")}>
                    {formatDateTime(job.createdAt)}
                  </td>
                  <td className={tableCellClass}>
                    {job.status === "failed" ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => retry.mutate(job.id)}
                        disabled={retry.isPending}
                      >
                        <RotateCcw size={14} />
                        重试
                      </Button>
                    ) : job.status === "queued" ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => cancel.mutate(job.id)}
                        disabled={cancel.isPending}
                      >
                        <Ban size={14} />
                        取消
                      </Button>
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td className={tableCellClass} colSpan={8}>
                  <span className="text-muted-foreground">{isLoading ? "加载中..." : "队列为空"}</span>
                </td>
              </tr>
            )}
          </tbody>
        </DataTable>
        <Pagination page={page} totalPages={totalPages} total={total} onPage={setPage} />
      </TableWrap>
    </div>
  );
}
