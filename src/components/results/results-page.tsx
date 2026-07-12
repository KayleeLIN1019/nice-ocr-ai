"use client";

import { Check, Filter, RotateCcw, Trash2 } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AuditStateBadge, ReviewClassBadge, RowStatusBadge, RiskBadge } from "@/components/ui/status";
import { ReasonList } from "@/components/ui/reason-badge";
import { DataTable, tableCellClass, tableHeadClass, TableWrap } from "@/components/ui/table";
import { FieldCell } from "@/components/ui/field-cell";
import { Dialog } from "@/components/ui/dialog";
import { ImageViewer } from "@/components/ui/image-viewer";
import { ExportMenu } from "@/components/results/export-menu";
import { BatchWorkspaceNav } from "@/components/batches/batch-workspace-nav";
import { BatchScopeSelect } from "@/components/batches/batch-scope-select";
import {
  DEFAULT_SCENARIO_ID,
  fieldCellWidthClass,
  getCommonCoreFields,
  getScenarioFields,
  isCoreColumn,
  type FieldDef,
} from "@/lib/fields/field-schema";
import { useFieldSchema } from "@/lib/fields/use-field-schema";
import { apiGet, apiJson } from "@/lib/api/client";
import { apiPaths } from "@/lib/api/paths";
import type { ExportScope } from "@/lib/workflows/exports";
import type { RecognitionRow, RiskLevel, RowStatus } from "@/lib/types";

interface ApiRecognitionRow {
  id: string;
  batchId: string;
  documentId: string;
  normalizedMonth?: string | null;
  code?: string | null;
  name: string;
  unit?: string | null;
  qty: number;
  price: number;
  amount: number;
  remark?: string | null;
  extraJson?: string | null;
  riskLevel: RiskLevel;
  status: RowStatus;
  reviewClass: string;
  auditState?: string | null;
  auditNote?: string | null;
  conflictState?: string | null;
  riskReasonsJson?: string | null;
  batch?: { name: string };
  document?: { originalName: string };
}

interface RowsPage {
  rows: ApiRecognitionRow[];
  total: number;
  page: number;
  /** 当前过滤结果集涉及的去重场景；驱动「全部」视图的混场景列退化。 */
  scenarioIds?: string[];
  multiCodeProducts?: MultiCodeProduct[];
}

interface MultiCodeProduct {
  name: string;
  total: number;
  blankCount: number;
  codes: Array<{ code: string; count: number }>;
}

function safeParseObject(raw?: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

function toRecognitionRow(row: ApiRecognitionRow): RecognitionRow {
  let reasons: string[] = [];
  try {
    reasons = JSON.parse(row.riskReasonsJson || "[]");
  } catch {
    reasons = [];
  }
  return {
    id: row.id,
    batchId: row.batchId,
    batchName: row.batch?.name ?? row.batchId,
    documentId: row.documentId,
    documentName: row.document?.originalName ?? row.documentId,
    month: row.normalizedMonth ?? "",
    code: row.code ?? "",
    name: row.name,
    unit: row.unit ?? "",
    qty: Number(row.qty) || 0,
    price: Number(row.price) || 0,
    amount: Number(row.amount) || 0,
    risk: row.riskLevel,
    status: row.status,
    reviewClass: row.reviewClass ?? "pending_review",
    auditState: row.auditState ?? "none",
    auditNote: row.auditNote ?? undefined,
    riskReasons: reasons,
    conflictReason: reasons.length ? reasons.join("、") : undefined,
    remark: row.remark ?? "",
    extra: safeParseObject(row.extraJson),
    updatedAt: "",
  };
}

/** 取字段在展示行上的当前值：核心列直接取，非核心列从 extra 取。 */
function fieldValue(row: RecognitionRow, field: FieldDef): string | number {
  if (isCoreColumn(field.key)) {
    return (
      (row as unknown as Record<string, string | number>)[field.key] ?? (field.type === "number" ? 0 : "")
    );
  }
  return row.extra[field.key] ?? "";
}

/** 把一次字段编辑乐观地合并进已缓存的某一行（核心列或 extraJson）。 */
function patchCachedRow(
  old: RowsPage | undefined,
  id: string,
  patch: Record<string, unknown>,
): RowsPage | undefined {
  if (!old?.rows) return old;
  return {
    ...old,
    rows: old.rows.map((row) => {
      if (row.id !== id) return row;
      const next: ApiRecognitionRow = { ...row };
      for (const [key, value] of Object.entries(patch)) {
        if (key === "extra") {
          next.extraJson = JSON.stringify({
            ...safeParseObject(row.extraJson),
            ...(value as Record<string, unknown>),
          });
        } else {
          (next as unknown as Record<string, unknown>)[key] = value;
        }
      }
      return next;
    }),
  };
}

const PAGE_SIZE = 50;

export function ResultsPage() {
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  // 作用域单一事实源：URL ?batchId=（空=全部）；其余筛选为页面本地状态。
  const batchId = searchParams.get("batchId") ?? "";
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState({
    status: searchParams.get("status") ?? "",
    risk: searchParams.get("risk") ?? "",
    audit: searchParams.get("audit") ?? "",
    q: searchParams.get("q") ?? searchParams.get("code") ?? searchParams.get("name") ?? "",
    searchMode: searchParams.get("searchMode") === "exact" ? ("exact" as const) : ("fuzzy" as const),
  });
  const [previewDocument, setPreviewDocument] = useState<{ id: string; name: string } | null>(null);
  const [replaceDrafts, setReplaceDrafts] = useState<Record<string, string>>({});
  const [replaceMessage, setReplaceMessage] = useState<string | null>(null);
  // 行级多选：按 id 跨页保留；选中时导出仅这些行（scope.rowIds），否则按当前筛选。
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());

  // 切换作用域（批次）时回到第一页并清空跨批次失效的多选（render 阶段调整，优于 effect）。
  const [prevBatchId, setPrevBatchId] = useState(batchId);
  if (prevBatchId !== batchId) {
    setPrevBatchId(batchId);
    setPage(1);
    setSelectedIds(new Set());
  }

  const queryString = (() => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (batchId) params.set("batchId", batchId);
    if (filters.status) params.set("status", filters.status);
    if (filters.risk) params.set("risk", filters.risk);
    if (filters.audit) params.set("auditState", filters.audit);
    if (filters.q) params.set("q", filters.q);
    if (filters.searchMode === "exact") params.set("searchMode", "exact");
    return params.toString();
  })();

  const { data, isLoading } = useQuery<RowsPage>({
    queryKey: ["rows", queryString],
    queryFn: () => apiGet(`${apiPaths.rows}?${queryString}`),
  });

  const rows = data?.rows?.map(toRecognitionRow) ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const multiCodeProducts = filters.q.trim() ? (data?.multiCodeProducts ?? []) : [];

  // 隔离模式额外取批次信息，导出默认带其绑定模板（与批次详情页一致）。共用 ["batch", id] 缓存。
  const { data: batchInfo } = useQuery<{ batch: { exportTemplateId?: string | null } }>({
    queryKey: ["batch", batchId],
    queryFn: () => apiGet(apiPaths.batch(batchId)),
    enabled: Boolean(batchId),
  });

  // 列解析（D5/D6）：隔离→批次场景；全部→单场景用该场景列、多场景退化为公共核心列并提示。
  const scenarioIds = data?.scenarioIds ?? [];
  const mixedScenarios = !batchId && scenarioIds.length > 1;
  const fieldScope = batchId
    ? { batchId }
    : scenarioIds.length === 1
      ? { scenarioId: scenarioIds[0] }
      : undefined;
  const fieldSchema = useFieldSchema(fieldScope);
  // 加载前用默认场景字段兜底，避免初次渲染列结构跳变。
  const fields = mixedScenarios
    ? getCommonCoreFields()
    : (fieldSchema.data?.fields ?? getScenarioFields(DEFAULT_SCENARIO_ID));

  const pageRowIds = rows.map((row) => row.id);
  const allPageSelected = pageRowIds.length > 0 && pageRowIds.every((id) => selectedIds.has(id));
  const selectedCount = selectedIds.size;

  function toggleRow(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function togglePage() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allPageSelected) pageRowIds.forEach((id) => next.delete(id));
      else pageRowIds.forEach((id) => next.add(id));
      return next;
    });
  }
  function clearSelection() {
    setSelectedIds(new Set());
  }

  // 选中行 → 导出仅这些行；否则按当前筛选条件导出。
  const exportScope: ExportScope =
    selectedCount > 0
      ? { rowIds: [...selectedIds] }
      : {
          batchId,
          status: filters.status,
          risk: filters.risk,
          auditState: filters.audit,
          q: filters.q,
          searchMode: filters.searchMode,
        };

  const updateRow = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) =>
      apiJson(apiPaths.row(id), { method: "PATCH", body: JSON.stringify(patch) }),
    // 乐观更新：就地改缓存行，不重排不闪烁；后台静默校正，避免编辑后整表重拉跳行。
    onMutate: async ({ id, patch }) => {
      await queryClient.cancelQueries({ queryKey: ["rows"] });
      queryClient.setQueriesData<RowsPage>({ queryKey: ["rows"] }, (old) => patchCachedRow(old, id, patch));
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["rows"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });

  function commitField(id: string, field: FieldDef, raw: string) {
    const value = field.type === "number" ? Number(raw || 0) : raw;
    const patch = isCoreColumn(field.key) ? { [field.key]: value } : { extra: { [field.key]: value } };
    updateRow.mutate({ id, patch });
  }

  const confirmRow = useMutation({
    mutationFn: (id: string) =>
      apiJson(apiPaths.rowsBulkConfirm, { method: "POST", body: JSON.stringify({ rowIds: [id] }) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["rows"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
  const excludeRow = useMutation({
    mutationFn: (id: string) => apiJson(apiPaths.row(id), { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["rows"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
  const rebuild = useMutation({
    mutationFn: () => apiJson(apiPaths.productsRebuild, { method: "POST", body: JSON.stringify({}) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["products"] }),
  });
  const replaceProductCode = useMutation({
    mutationFn: ({ name, toCode }: { name: string; toCode: string }) =>
      apiJson<{ matched: number; updated: number }>(apiPaths.rowsReplaceProductCode, {
        method: "POST",
        body: JSON.stringify({
          name,
          toCode,
          batchId: batchId || undefined,
          status: filters.status || undefined,
          risk: filters.risk || undefined,
          auditState: filters.audit || undefined,
        }),
      }),
    onSuccess: (result, variables) => {
      setReplaceMessage(
        `已将「${variables.name}」统一为编码 ${variables.toCode}，更新 ${result.updated} / ${result.matched} 行。`,
      );
      queryClient.invalidateQueries({ queryKey: ["rows"] });
      queryClient.invalidateQueries({ queryKey: ["products"] });
      queryClient.invalidateQueries({ queryKey: ["conflicts"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });

  function patchFilter(patch: Partial<typeof filters>) {
    setPage(1);
    setReplaceMessage(null);
    setFilters((current) => ({ ...current, ...patch }));
  }

  function draftCodeFor(product: MultiCodeProduct) {
    return replaceDrafts[product.name] ?? product.codes[0]?.code ?? "";
  }

  function setDraftCode(productName: string, code: string) {
    setReplaceDrafts((current) => ({ ...current, [productName]: code }));
  }

  function replaceCode(product: MultiCodeProduct) {
    const toCode = draftCodeFor(product).trim();
    if (!toCode) {
      if (typeof window !== "undefined") window.alert("请输入要统一替换成的产品编码。");
      return;
    }
    const confirmed =
      typeof window === "undefined" ||
      window.confirm(
        `确认将当前筛选范围内「${product.name}」的 ${product.total} 行编码统一为「${toCode}」？`,
      );
    if (!confirmed) return;
    replaceProductCode.mutate({ name: product.name, toCode });
  }

  const columnCount = 5 + fields.length + 6;

  return (
    <div className="space-y-4">
      {batchId ? <BatchWorkspaceNav batchId={batchId} active="results" /> : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">全部结果</h1>
          <p className="mt-1 text-sm text-muted-foreground">查看、筛选、编辑、确认所有识别明细行。</p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" onClick={() => rebuild.mutate()} disabled={rebuild.isPending}>
            <RotateCcw size={15} />
            重建产品库
          </Button>
          <ExportMenu scope={exportScope} defaultTemplateId={batchInfo?.batch.exportTemplateId} />
        </div>
      </div>

      <div className="rounded-lg border border-border bg-surface p-3">
        <div className="flex flex-wrap items-center gap-2">
          <BatchScopeSelect batchId={batchId} />
          <select
            className="h-9 rounded-md border border-border bg-surface px-3 text-sm"
            value={filters.status}
            onChange={(event) => patchFilter({ status: event.target.value })}
          >
            <option value="">全部状态</option>
            <option value="pending">待审核</option>
            <option value="confirmed">已确认</option>
            <option value="conflict">冲突</option>
            <option value="excluded">已排除</option>
          </select>
          <select
            className="h-9 rounded-md border border-border bg-surface px-3 text-sm"
            value={filters.risk}
            onChange={(event) => patchFilter({ risk: event.target.value })}
          >
            <option value="">风险：全部</option>
            <option value="high">高</option>
            <option value="medium">中</option>
            <option value="low">低</option>
          </select>
          <select
            className="h-9 rounded-md border border-border bg-surface px-3 text-sm"
            value={filters.audit}
            onChange={(event) => patchFilter({ audit: event.target.value })}
          >
            <option value="">审核：全部</option>
            <option value="flagged">待复审</option>
            <option value="passed">审核通过</option>
            <option value="reviewed">已复审</option>
            <option value="none">未审核</option>
          </select>
          <div className="inline-flex h-9 overflow-hidden rounded-md border border-border bg-surface text-sm">
            <button
              type="button"
              className={
                filters.searchMode === "fuzzy"
                  ? "bg-primary px-3 text-primary-foreground"
                  : "px-3 text-muted-foreground hover:bg-muted hover:text-foreground"
              }
              onClick={() => patchFilter({ searchMode: "fuzzy" })}
            >
              模糊搜索
            </button>
            <button
              type="button"
              className={
                filters.searchMode === "exact"
                  ? "bg-primary px-3 text-primary-foreground"
                  : "px-3 text-muted-foreground hover:bg-muted hover:text-foreground"
              }
              onClick={() => patchFilter({ searchMode: "exact" })}
            >
              精确搜索
            </button>
          </div>
          <input
            className="h-9 w-56 rounded-md border border-border px-3 text-sm"
            placeholder="产品编码/名称"
            value={filters.q}
            onChange={(event) => patchFilter({ q: event.target.value })}
          />
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Filter size={14} />共 {total} 条
          </span>
          {selectedCount > 0 ? (
            <span className="inline-flex items-center gap-2 text-xs text-foreground">
              已选 {selectedCount} 行
              <button
                className="text-muted-foreground underline-offset-2 hover:underline"
                onClick={clearSelection}
              >
                清除
              </button>
            </span>
          ) : null}
        </div>
      </div>

      {multiCodeProducts.length ? (
        <div className="rounded-lg border border-warning/40 bg-warning/10 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-foreground">同名多编码</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                当前筛选结果中有 {multiCodeProducts.length} 个商品名出现多个编码。
              </p>
            </div>
            {replaceMessage ? <span className="text-xs text-success-strong">{replaceMessage}</span> : null}
          </div>
          <div className="mt-3 divide-y divide-warning/30">
            {multiCodeProducts.map((product) => {
              const draftCode = draftCodeFor(product);
              return (
                <div
                  key={product.name}
                  className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-foreground">{product.name}</span>
                      <Badge tone="warning">{product.total} 行</Badge>
                      {product.blankCount ? <Badge>{product.blankCount} 行空编码</Badge> : null}
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {product.codes.map((item) => (
                        <button
                          key={item.code}
                          type="button"
                          onClick={() => setDraftCode(product.name, item.code)}
                          className="inline-flex h-7 items-center gap-1 rounded-full border border-border bg-surface px-2 text-xs text-foreground hover:bg-muted"
                          title={`设为目标编码 ${item.code}`}
                        >
                          {draftCode === item.code ? (
                            <Check size={13} className="text-success-strong" />
                          ) : null}
                          <span className="font-medium">{item.code}</span>
                          <span className="text-muted-foreground">×{item.count}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      className="h-8 w-36 rounded-md border border-border bg-surface px-2 text-sm"
                      value={draftCode}
                      onChange={(event) => setDraftCode(product.name, event.target.value)}
                      aria-label={`统一 ${product.name} 的编码`}
                    />
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() => replaceCode(product)}
                      disabled={replaceProductCode.isPending}
                    >
                      一键替换
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {mixedScenarios ? (
        <div className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-foreground">
          当前为多场景混合视图，仅显示公共核心列；选择具体批次可查看该场景完整字段列。
        </div>
      ) : null}

      <TableWrap>
        <DataTable>
          <thead className={tableHeadClass}>
            <tr>
              <th className={tableCellClass}>
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-primary align-middle"
                  aria-label="选择本页全部行"
                  checked={allPageSelected}
                  onChange={togglePage}
                />
              </th>
              <th className={tableCellClass}>行号</th>
              <th className={tableCellClass}>批次</th>
              <th className={tableCellClass}>文档</th>
              <th className={tableCellClass}>月份</th>
              {fields.map((field) => (
                <th key={field.key} className={tableCellClass}>
                  {field.label}
                </th>
              ))}
              <th className={tableCellClass}>风险</th>
              <th className={tableCellClass}>状态</th>
              <th className={tableCellClass}>标识类别</th>
              <th className={tableCellClass}>审核</th>
              <th className={tableCellClass}>冲突原因</th>
              <th className={tableCellClass}>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.length ? (
              rows.map((row, index) => (
                <tr key={row.id} className={selectedIds.has(row.id) ? "bg-primary/5" : "hover:bg-muted/70"}>
                  <td className={tableCellClass}>
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-primary align-middle"
                      aria-label={`选择第 ${(page - 1) * PAGE_SIZE + index + 1} 行`}
                      checked={selectedIds.has(row.id)}
                      onChange={() => toggleRow(row.id)}
                    />
                  </td>
                  <td className={tableCellClass}>{(page - 1) * PAGE_SIZE + index + 1}</td>
                  <td className={tableCellClass}>
                    <Link href={`/batches/${row.batchId}`} className="text-primary hover:underline">
                      {row.batchName}
                    </Link>
                  </td>
                  <td className={tableCellClass}>
                    <button
                      type="button"
                      onClick={() => setPreviewDocument({ id: row.documentId, name: row.documentName })}
                      className="max-w-48 truncate text-left text-primary underline-offset-2 hover:underline"
                      title="查看原图"
                    >
                      {row.documentName}
                    </button>
                  </td>
                  <td className={tableCellClass}>{row.month || "-"}</td>
                  {fields.map((field) => (
                    <FieldCell
                      key={field.key}
                      value={fieldValue(row, field)}
                      type={field.type === "number" ? "number" : "text"}
                      align={field.align ?? (field.type === "number" ? "right" : "left")}
                      disabled={!field.editable}
                      widthClass={fieldCellWidthClass(field)}
                      onCommit={(next) => commitField(row.id, field, next)}
                    />
                  ))}
                  <td className={tableCellClass}>
                    <RiskBadge risk={row.risk} />
                  </td>
                  <td className={tableCellClass}>
                    <RowStatusBadge status={row.status} />
                  </td>
                  <td className={tableCellClass}>
                    <ReviewClassBadge value={row.reviewClass} />
                  </td>
                  <td className={tableCellClass}>
                    <span title={row.auditNote ?? undefined}>
                      <AuditStateBadge value={row.auditState ?? "none"} />
                    </span>
                  </td>
                  <td className={tableCellClass}>
                    <ReasonList codes={row.riskReasons ?? []} emptyText="-" />
                  </td>
                  <td className={tableCellClass}>
                    <div className="flex gap-1">
                      {row.status !== "confirmed" || row.auditState === "flagged" ? (
                        <Button size="sm" variant="ghost" asChild>
                          <Link
                            href={`/review?batchId=${row.batchId}&documentId=${row.documentId}`}
                            title="到审核台查看原图并逐行复核"
                          >
                            审核
                          </Link>
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => confirmRow.mutate(row.id)}
                        disabled={confirmRow.isPending || row.status === "confirmed"}
                      >
                        确认
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label="排除行"
                        onClick={() => excludeRow.mutate(row.id)}
                        disabled={excludeRow.isPending}
                      >
                        <Trash2 size={15} />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td className={tableCellClass} colSpan={columnCount}>
                  <span className="text-muted-foreground">
                    {isLoading ? "加载中..." : "没有符合条件的记录"}
                  </span>
                </td>
              </tr>
            )}
          </tbody>
        </DataTable>
        <div className="flex items-center justify-between border-t border-border px-4 py-3 text-xs text-muted-foreground">
          <span>
            共 {total} 条，第 {page} / {totalPages} 页
          </span>
          <div className="flex items-center gap-1">
            <button
              className="h-7 min-w-7 rounded border border-border bg-surface px-2 hover:bg-muted disabled:opacity-50"
              onClick={() => setPage((current) => Math.max(1, current - 1))}
              disabled={page <= 1}
            >
              上一页
            </button>
            <button
              className="h-7 min-w-7 rounded border border-border bg-surface px-2 hover:bg-muted disabled:opacity-50"
              onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
              disabled={page >= totalPages}
            >
              下一页
            </button>
          </div>
        </div>
      </TableWrap>
      <Dialog
        open={Boolean(previewDocument)}
        onClose={() => setPreviewDocument(null)}
        title={previewDocument?.name ?? "原图预览"}
        description="可缩放、拖拽核对原图"
        className="max-w-6xl"
      >
        <div className="h-[72vh] min-h-96 overflow-hidden rounded-md border border-border">
          <ImageViewer
            className="h-full"
            src={previewDocument ? apiPaths.documentImage(previewDocument.id) : null}
            alt={previewDocument?.name ?? "单据原图"}
          />
        </div>
      </Dialog>
    </div>
  );
}
