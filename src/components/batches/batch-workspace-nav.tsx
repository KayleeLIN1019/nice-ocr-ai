"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { BatchStatusBadge } from "@/components/ui/status";
import { apiGet } from "@/lib/api/client";
import { apiPaths } from "@/lib/api/paths";
import { cn, formatNumber } from "@/lib/utils";
import type { BatchStatus } from "@/lib/types";

type WorkspaceTab = "overview" | "review" | "results";

interface NavBatch {
  batch: {
    id: string;
    name: string;
    status: string;
    closedAt?: string | null;
    documents: Array<{
      reviewState: "pending" | "partial" | "confirmed" | "conflict";
      rowStats: { total: number; confirmed: number; conflict: number };
    }>;
  };
}

/**
 * 批次工作区导航条：在批次详情 / 审核台 / 全部结果（带 batchId 上下文时）三处统一渲染，
 * 把原本割裂的三个入口串成「同一个批次工作区」的连续标签流。
 * 自取 /api/batches/:id（与详情页/审核台共用 ["batch", id] 缓存，不产生重复请求）。
 */
export function BatchWorkspaceNav({ batchId, active }: { batchId: string; active: WorkspaceTab }) {
  const { data } = useQuery<NavBatch>({
    queryKey: ["batch", batchId],
    queryFn: () => apiGet(apiPaths.batch(batchId)),
  });
  const batch = data?.batch;
  const docs = batch?.documents ?? [];
  const totalRows = docs.reduce((sum, doc) => sum + doc.rowStats.total, 0);
  const confirmedRows = docs.reduce((sum, doc) => sum + doc.rowStats.confirmed, 0);
  const confirmedDocs = docs.filter((doc) => doc.reviewState === "confirmed").length;
  const pct = totalRows > 0 ? Math.round((confirmedRows / totalRows) * 100) : 0;

  const tabs: Array<{ key: WorkspaceTab; label: string; href: string }> = [
    { key: "overview", label: "概览", href: `/batches/${batchId}` },
    { key: "review", label: "审核", href: `/review?batchId=${batchId}` },
    { key: "results", label: "结果", href: `/results?batchId=${batchId}` },
  ];

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface px-3 py-2">
      <div className="flex min-w-0 items-center gap-3">
        <Link href="/batches" className="shrink-0 text-xs text-muted-foreground hover:text-primary">
          批次工作区
        </Link>
        <span className="truncate text-sm font-medium">{batch?.name ?? "加载中…"}</span>
        {batch ? <BatchStatusBadge status={batch.status as BatchStatus} /> : null}
        {batch?.closedAt ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-success/40 bg-success/10 px-2 py-0.5 text-xs text-success-strong">
            已封批
          </span>
        ) : null}
        {totalRows > 0 ? (
          <span className="hidden items-center gap-2 lg:flex">
            <span className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
              <span className="block h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
            </span>
            <span className="text-xs text-muted-foreground">
              已确认 {formatNumber(confirmedRows)}/{formatNumber(totalRows)} 行 · {confirmedDocs}/{docs.length} 文档
            </span>
            {pct === 100 ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-success/40 bg-success/10 px-2 py-0.5 text-xs text-success-strong">
                可导出
              </span>
            ) : null}
          </span>
        ) : null}
      </div>
      <nav className="flex items-center gap-1">
        {tabs.map((tab) => (
          <Link
            key={tab.key}
            href={tab.href}
            aria-current={tab.key === active ? "page" : undefined}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm transition-colors",
              tab.key === active
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {tab.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
