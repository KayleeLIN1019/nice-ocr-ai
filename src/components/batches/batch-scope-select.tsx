"use client";

import { Layers } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { usePathname, useRouter } from "next/navigation";
import { apiGet } from "@/lib/api/client";
import { apiPaths } from "@/lib/api/paths";

interface BatchOption {
  id: string;
  name: string;
}

/**
 * 批次作用域选择器（全部结果 / 审核工作台 共用）。
 *
 * 单一事实源是 URL `?batchId=`：选「全部」移除该参数（默认作用域），选某批次写入 batchId。
 * 切换作用域时一并丢弃 `documentId`（它属于某个具体批次，跨批次后失效）。
 */
export function BatchScopeSelect({ batchId }: { batchId: string }) {
  const router = useRouter();
  const pathname = usePathname();

  // 轻量批次选项：名称 + id，倒序；放大 pageSize 一次取齐供下拉使用。
  const { data } = useQuery<{ batches: BatchOption[] }>({
    queryKey: ["batches", "scope-options"],
    queryFn: () => apiGet(`${apiPaths.batches}?pageSize=100`),
    staleTime: 60 * 1000,
  });
  const batches = data?.batches ?? [];

  function onChange(next: string) {
    if (next) router.push(`${pathname}?batchId=${next}`);
    else router.push(pathname);
  }

  return (
    <label className="inline-flex items-center gap-2 text-sm">
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <Layers size={14} />批次
      </span>
      <select
        className="h-9 min-w-40 rounded-md border border-border bg-surface px-3 text-sm outline-none focus:border-primary"
        value={batchId}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">全部</option>
        {batches.map((batch) => (
          <option key={batch.id} value={batch.id}>
            {batch.name}
          </option>
        ))}
      </select>
    </label>
  );
}
