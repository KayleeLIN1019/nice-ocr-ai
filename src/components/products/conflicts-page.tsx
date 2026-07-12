"use client";

import { Ban, CheckCircle2 } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RiskBadge } from "@/components/ui/status";
import { ReasonBadge } from "@/components/ui/reason-badge";
import { DataTable, tableCellClass, tableHeadClass, TableWrap } from "@/components/ui/table";
import { Pagination } from "@/components/ui/pagination";
import { apiGet, apiJson } from "@/lib/api/client";
import { apiPaths } from "@/lib/api/paths";
import type { RiskLevel } from "@/lib/types";

interface ApiConflict {
  id: string;
  type: string;
  severity: RiskLevel;
  reason: string;
  sourceRowIdsJson?: string;
  status: "open" | "resolved" | "ignored";
  product?: { name: string; code?: string | null } | null;
  variants?: {
    kind: "code" | "name";
    items: Array<{ value: string; count: number; isMinority: boolean }>;
  };
}

const statusBadge: Record<ApiConflict["status"], { label: string; tone: "warning" | "success" | "neutral" }> =
  {
    open: { label: "未处理", tone: "warning" },
    resolved: { label: "已解决", tone: "success" },
    ignored: { label: "已忽略", tone: "neutral" },
  };

function productResultsHref(conflict: ApiConflict) {
  const q =
    conflict.type === "CODE_NAME_CONFLICT"
      ? (conflict.product?.code ?? conflict.product?.name ?? "")
      : (conflict.product?.name ?? conflict.product?.code ?? "");
  if (!q) return null;
  const params = new URLSearchParams({ q, searchMode: "exact" });
  return `/results?${params.toString()}`;
}

export function ConflictsPage() {
  const queryClient = useQueryClient();
  const [onlyOpen, setOnlyOpen] = useState(true);
  const [page, setPage] = useState(1);
  const [replaceDrafts, setReplaceDrafts] = useState<Record<string, string>>({});
  const [replaceMessage, setReplaceMessage] = useState<string | null>(null);

  const PAGE_SIZE = 20;
  const queryString = (() => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (onlyOpen) params.set("status", "open");
    return params.toString();
  })();

  const { data, isLoading } = useQuery<{ conflicts: ApiConflict[]; total: number }>({
    queryKey: ["conflicts", queryString],
    queryFn: () => apiGet(`${apiPaths.conflicts}?${queryString}`),
  });

  const resolve = useMutation({
    mutationFn: ({ id, status }: { id: string; status: "resolved" | "ignored" }) =>
      apiJson(apiPaths.conflict(id), { method: "PATCH", body: JSON.stringify({ status }) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["conflicts"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      queryClient.invalidateQueries({ queryKey: ["products"] });
    },
  });

  const replaceCode = useMutation({
    mutationFn: ({ conflict, toCode }: { conflict: ApiConflict; toCode: string }) =>
      apiJson<{ matched: number; updated: number }>(apiPaths.rowsReplaceProductCode, {
        method: "POST",
        body: JSON.stringify({
          name: conflict.product?.name,
          toCode,
          rowIds: safeParseArray(conflict.sourceRowIdsJson),
        }),
      }),
    onSuccess: (result, variables) => {
      setReplaceMessage(
        `已将「${variables.conflict.product?.name ?? "-"}」统一为编码 ${variables.toCode}，更新 ${result.updated} / ${result.matched} 行。`,
      );
      invalidateAfterReplace();
    },
  });

  const replaceName = useMutation({
    mutationFn: ({ conflict, toName }: { conflict: ApiConflict; toName: string }) =>
      apiJson<{ matched: number; updated: number }>(apiPaths.rowsReplaceProductName, {
        method: "POST",
        body: JSON.stringify({
          code: conflict.product?.code,
          toName,
          rowIds: safeParseArray(conflict.sourceRowIdsJson),
        }),
      }),
    onSuccess: (result, variables) => {
      setReplaceMessage(
        `已将编码 ${variables.conflict.product?.code ?? "-"} 统一为「${variables.toName}」，更新 ${result.updated} / ${result.matched} 行。`,
      );
      invalidateAfterReplace();
    },
  });

  function invalidateAfterReplace() {
    queryClient.invalidateQueries({ queryKey: ["conflicts"] });
    queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    queryClient.invalidateQueries({ queryKey: ["products"] });
    queryClient.invalidateQueries({ queryKey: ["rows"] });
    queryClient.invalidateQueries({ queryKey: ["suggest"] });
  }

  const conflicts = data?.conflicts ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function draftValue(conflict: ApiConflict) {
    const existing = replaceDrafts[conflict.id];
    if (existing !== undefined) return existing;
    return conflict.variants?.items.find((item) => item.value !== "空编码")?.value ?? "";
  }

  function setDraftValue(conflictId: string, value: string) {
    setReplaceDrafts((current) => ({ ...current, [conflictId]: value }));
  }

  function replaceConflict(conflict: ApiConflict) {
    const target = draftValue(conflict).trim();
    if (!target || target === "空编码") {
      if (typeof window !== "undefined") window.alert("请选择或输入要统一成的值。");
      return;
    }
    if (conflict.variants?.kind === "code" && !conflict.product?.name) return;
    if (conflict.variants?.kind === "name" && !conflict.product?.code) return;

    const label = conflict.variants?.kind === "name" ? "商品名" : "编码";
    const confirmed =
      typeof window === "undefined" ||
      window.confirm(`确认将这条冲突的来源明细统一${label}为「${target}」？`);
    if (!confirmed) return;

    if (conflict.variants?.kind === "name") replaceName.mutate({ conflict, toName: target });
    else if (conflict.variants?.kind === "code") replaceCode.mutate({ conflict, toCode: target });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">冲突管理</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            按严重程度处理产品库和识别明细中的数据质量问题。
          </p>
        </div>
        {replaceMessage ? <span className="text-xs text-success-strong">{replaceMessage}</span> : null}
        <label className="inline-flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            className="h-4 w-4"
            checked={onlyOpen}
            onChange={(event) => {
              setOnlyOpen(event.target.checked);
              setPage(1);
            }}
          />
          仅看未处理
        </label>
      </div>

      <TableWrap>
        <DataTable>
          <thead className={tableHeadClass}>
            <tr>
              <th className={tableCellClass}>冲突类型</th>
              <th className={tableCellClass}>严重度</th>
              <th className={tableCellClass}>产品</th>
              <th className={tableCellClass}>原因</th>
              <th className={tableCellClass}>来源行</th>
              <th className={tableCellClass}>状态</th>
              <th className={tableCellClass}>操作</th>
            </tr>
          </thead>
          <tbody>
            {conflicts.length ? (
              conflicts.map((conflict) => {
                const sourceCount = safeParseArray(conflict.sourceRowIdsJson).length;
                const badge = statusBadge[conflict.status];
                const resultsHref = productResultsHref(conflict);
                return (
                  <tr key={conflict.id} className="hover:bg-muted/70">
                    <td className={tableCellClass}>
                      <ReasonBadge code={conflict.type} />
                    </td>
                    <td className={tableCellClass}>
                      <RiskBadge risk={conflict.severity} />
                    </td>
                    <td className={tableCellClass}>
                      {resultsHref ? (
                        <Link
                          href={resultsHref}
                          className="text-primary underline-offset-2 hover:underline"
                          title="在全部结果中精确搜索该商品"
                        >
                          {conflict.product?.name ?? conflict.product?.code}
                        </Link>
                      ) : (
                        "-"
                      )}
                    </td>
                    <td className={tableCellClass}>
                      <div>{conflict.reason}</div>
                      {conflict.variants?.items.length ? (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {conflict.variants.items.map((item) => (
                            <button
                              key={item.value}
                              type="button"
                              onClick={() => setDraftValue(conflict.id, item.value)}
                              className={
                                item.isMinority
                                  ? "inline-flex h-7 items-center gap-1 rounded-full border border-warning/60 bg-warning/15 px-2 text-xs text-warning-strong hover:bg-warning/25"
                                  : "inline-flex h-7 items-center gap-1 rounded-full border border-border bg-surface px-2 text-xs text-foreground hover:bg-muted"
                              }
                              title={`设为统一目标：${item.value}`}
                            >
                              <span className="font-medium">{item.value}</span>
                              <span className="text-muted-foreground">×{item.count}</span>
                              {item.isMinority ? <span className="text-[10px]">少</span> : null}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </td>
                    <td className={tableCellClass}>{sourceCount}</td>
                    <td className={tableCellClass}>
                      <Badge tone={badge.tone}>{badge.label}</Badge>
                    </td>
                    <td className={tableCellClass}>
                      <div className="flex flex-wrap gap-1">
                        {conflict.variants?.kind ? (
                          <div className="flex flex-wrap items-center gap-1">
                            <input
                              className="h-8 w-32 rounded-md border border-border bg-surface px-2 text-xs"
                              value={draftValue(conflict)}
                              onChange={(event) => setDraftValue(conflict.id, event.target.value)}
                              aria-label={
                                conflict.variants.kind === "name" ? "统一后的商品名" : "统一后的编码"
                              }
                            />
                            <Button
                              size="sm"
                              variant="primary"
                              onClick={() => replaceConflict(conflict)}
                              disabled={
                                conflict.status !== "open" || replaceCode.isPending || replaceName.isPending
                              }
                            >
                              {conflict.variants.kind === "name" ? "统一名称" : "统一编码"}
                            </Button>
                          </div>
                        ) : null}
                        {resultsHref ? (
                          <Button size="sm" variant="secondary" asChild>
                            <Link href={resultsHref}>去修复</Link>
                          </Button>
                        ) : null}
                        <Button
                          size="sm"
                          variant="primary"
                          onClick={() => resolve.mutate({ id: conflict.id, status: "resolved" })}
                          disabled={resolve.isPending || conflict.status !== "open"}
                        >
                          <CheckCircle2 size={14} />
                          解决
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => resolve.mutate({ id: conflict.id, status: "ignored" })}
                          disabled={resolve.isPending || conflict.status !== "open"}
                          title="仅隐藏该冲突记录，不修改识别明细"
                        >
                          <Ban size={14} />
                          忽略
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })
            ) : (
              <tr>
                <td className={tableCellClass} colSpan={7}>
                  <span className="text-muted-foreground">{isLoading ? "加载中..." : "暂无冲突"}</span>
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

function safeParseArray(json: string | undefined): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
