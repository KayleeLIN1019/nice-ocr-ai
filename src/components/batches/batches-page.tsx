"use client";

import {
  CalendarPlus,
  ChevronRight,
  FileSearch,
  PackageOpen,
  Pencil,
  Plus,
  Trash2,
  UploadCloud,
  X,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Panel, PanelHeader, PanelTitle } from "@/components/ui/card";
import { ApprovalModeBadge, BatchStatusBadge } from "@/components/ui/status";
import { DataTable, tableCellClass, tableHeadClass, TableWrap } from "@/components/ui/table";
import { Pagination } from "@/components/ui/pagination";
import { formatDateTime, formatNumber } from "@/lib/utils";
import {
  CreateBatchDrawer,
  type BatchModelOptionProvider,
  type CreateBatchPayload,
} from "@/components/dialogs/action-dialogs";
import { apiGet, apiJson, apiUpload } from "@/lib/api/client";
import { apiPaths } from "@/lib/api/paths";
import type { BatchStatus } from "@/lib/types";

interface ApiBatch {
  id: string;
  name: string;
  status: string;
  strategy: string;
  approvalMode: string;
  createdAt: string;
  _count?: { documents: number; rows: number };
  progress?: { total: number; confirmed: number; conflict: number };
  unfinishedDocuments?: UnfinishedDocument[];
}

interface UnfinishedDocument {
  id: string;
  originalName: string;
  pendingRows: number;
  firstRowId: string;
  firstRowIndex: number;
  firstRowName: string;
  firstRowCode: string | null;
}

interface ApiMonthBatch {
  id: string;
  name: string;
  month: string;
  notes?: string | null;
  createdAt: string;
  batchCount: number;
  documentCount: number;
  rowCount: number;
  batches: Array<{
    id: string;
    name: string;
    status: string;
    createdAt: string;
    _count: { documents: number; rows: number };
  }>;
}

interface BatchPickerOption {
  id: string;
  name: string;
  _count?: { documents: number; rows: number };
}

interface MonthBatchPayload {
  name: string;
  month: string;
  notes: string;
  batchIds: string[];
}

interface SettingsForBatchCreate {
  defaults: { approvalMode: string; strategy: string };
  providers: BatchModelOptionProvider[];
}

export function BatchesPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadTargetRef = useRef<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createMonthOpen, setCreateMonthOpen] = useState(false);
  const [editMonthTarget, setEditMonthTarget] = useState<ApiMonthBatch | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ApiBatch | null>(null);
  const [deleteMonthTarget, setDeleteMonthTarget] = useState<ApiMonthBatch | null>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [monthFilter, setMonthFilter] = useState("");
  const [page, setPage] = useState(1);

  const PAGE_SIZE = 20;
  const queryString = (() => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (search) params.set("search", search);
    if (status) params.set("status", status);
    return params.toString();
  })();

  const { data, isLoading } = useQuery<{ batches: ApiBatch[]; total: number }>({
    queryKey: ["batches", queryString],
    queryFn: () => apiGet(`${apiPaths.batches}?${queryString}`),
  });
  const { data: settings } = useQuery<SettingsForBatchCreate>({
    queryKey: ["settings"],
    queryFn: () => apiGet(apiPaths.settings),
  });
  const { data: monthBatchData, isLoading: monthBatchesLoading } = useQuery<{
    monthBatches: ApiMonthBatch[];
    total: number;
  }>({
    queryKey: ["month-batches", monthFilter],
    queryFn: () => {
      const params = new URLSearchParams({ pageSize: "20" });
      if (monthFilter) params.set("month", monthFilter);
      return apiGet(`${apiPaths.monthBatches}?${params.toString()}`);
    },
  });
  const { data: batchOptionData } = useQuery<{ batches: ApiBatch[] }>({
    queryKey: ["batches", "month-options"],
    queryFn: () => apiGet(`${apiPaths.batches}?pageSize=100`),
    staleTime: 60 * 1000,
  });

  const createBatch = useMutation({
    mutationFn: (payload: CreateBatchPayload) =>
      apiJson(apiPaths.batches, { method: "POST", body: JSON.stringify(payload) }),
    onSuccess: () => {
      setCreateOpen(false);
      queryClient.invalidateQueries({ queryKey: ["batches"] });
    },
  });
  const createMonthBatch = useMutation({
    mutationFn: (payload: MonthBatchPayload) =>
      apiJson(apiPaths.monthBatches, { method: "POST", body: JSON.stringify(payload) }),
    onSuccess: () => {
      setCreateMonthOpen(false);
      queryClient.invalidateQueries({ queryKey: ["month-batches"] });
    },
  });
  const updateMonthBatch = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: MonthBatchPayload }) =>
      apiJson(apiPaths.monthBatch(id), { method: "PATCH", body: JSON.stringify(payload) }),
    onSuccess: () => {
      setEditMonthTarget(null);
      queryClient.invalidateQueries({ queryKey: ["month-batches"] });
    },
  });

  const uploadFiles = useMutation({
    mutationFn: ({ batchId, files }: { batchId: string; files: File[] }) => {
      const formData = new FormData();
      files.forEach((file) => formData.append("files", file));
      return apiUpload(apiPaths.batchUpload(batchId), formData);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["batches"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });

  const deleteBatch = useMutation({
    mutationFn: (batchId: string) => apiJson(apiPaths.batch(batchId), { method: "DELETE" }),
    onSuccess: () => {
      setDeleteTarget(null);
      queryClient.invalidateQueries({ queryKey: ["batches"] });
      queryClient.invalidateQueries({ queryKey: ["month-batches"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
  const deleteMonthBatch = useMutation({
    mutationFn: (monthBatchId: string) => apiJson(apiPaths.monthBatch(monthBatchId), { method: "DELETE" }),
    onSuccess: () => {
      setDeleteMonthTarget(null);
      queryClient.invalidateQueries({ queryKey: ["month-batches"] });
    },
  });

  function triggerUpload(batchId: string) {
    uploadTargetRef.current = batchId;
    fileInputRef.current?.click();
  }

  const batches = data?.batches ?? [];
  const batchOptions = mergeBatchOptions(batchOptionData?.batches ?? batches, editMonthTarget?.batches ?? []);
  const monthBatches = monthBatchData?.monthBatches ?? [];
  const monthDialogOpen = createMonthOpen || Boolean(editMonthTarget);
  const monthDialogPending = createMonthBatch.isPending || updateMonthBatch.isPending;
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-4">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/*,application/pdf,.pdf,.zip,application/zip"
        className="hidden"
        onChange={(event) => {
          // 同步把 FileList 快照成 File[]：下面的 value="" 会清空这个「活」FileList，
          // 而 mutation 是异步读取，必须先固化文件引用，否则上传到的是空 FormData。
          const files = event.target.files ? Array.from(event.target.files) : [];
          const batchId = uploadTargetRef.current;
          event.target.value = "";
          if (files.length && batchId) {
            uploadFiles.mutate({ batchId, files });
          }
        }}
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">批次管理</h1>
          <p className="mt-1 text-sm text-muted-foreground">按批次维护上传、识别、审核、导出进度。</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" onClick={() => setCreateMonthOpen(true)}>
            <CalendarPlus size={15} />
            新建月份批次
          </Button>
          <Button size="sm" variant="primary" onClick={() => setCreateOpen(true)}>
            <Plus size={15} />
            新建批次
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface p-3">
        <input
          className="h-9 w-64 rounded-md border border-border px-3 text-sm outline-none focus:border-primary"
          placeholder="搜索批次名称"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(1);
          }}
        />
        <select
          className="h-9 rounded-md border border-border bg-surface px-3 text-sm outline-none focus:border-primary"
          value={status}
          onChange={(event) => {
            setStatus(event.target.value);
            setPage(1);
          }}
        >
          <option value="">全部状态</option>
          <option value="draft">草稿</option>
          <option value="processing">处理中</option>
          <option value="completed">完成</option>
          <option value="failed">失败</option>
        </select>
        {uploadFiles.isPending ? (
          <span className="text-xs text-muted-foreground">上传解析中...</span>
        ) : uploadFiles.isError ? (
          <span className="text-xs text-danger">{(uploadFiles.error as Error)?.message ?? "上传失败"}</span>
        ) : (
          <span className="text-xs text-muted-foreground">支持 图片 / PDF / ZIP 压缩包</span>
        )}
      </div>

      <TableWrap>
        <DataTable>
          <thead className={tableHeadClass}>
            <tr>
              <th className={tableCellClass}>批次名称</th>
              <th className={tableCellClass}>状态</th>
              <th className={tableCellClass}>文档数</th>
              <th className={tableCellClass}>行数</th>
              <th className={tableCellClass}>审核进度</th>
              <th className={tableCellClass}>审批模式</th>
              <th className={tableCellClass}>策略</th>
              <th className={tableCellClass}>创建时间</th>
              <th className={tableCellClass}>操作</th>
            </tr>
          </thead>
          <tbody>
            {batches.length ? (
              batches.map((batch) => (
                <tr
                  key={batch.id}
                  className="cursor-pointer transition-colors hover:bg-muted/70"
                  onClick={() => router.push(`/batches/${batch.id}`)}
                  title="点击查看批次详情与预览"
                >
                  <td className={tableCellClass}>
                    <span className="font-medium text-primary">{batch.name}</span>
                  </td>
                  <td className={tableCellClass}>
                    <BatchStatusBadge status={batch.status as BatchStatus} />
                  </td>
                  <td className={tableCellClass}>{formatNumber(batch._count?.documents ?? 0)}</td>
                  <td className={tableCellClass}>{formatNumber(batch._count?.rows ?? 0)}</td>
                  <td className={tableCellClass}>
                    <BatchProgressCell
                      progress={batch.progress}
                      unfinishedDocuments={batch.unfinishedDocuments ?? []}
                      onOpenDocument={(document) =>
                        router.push(
                          `/review?batchId=${batch.id}&documentId=${document.id}&rowId=${document.firstRowId}`,
                        )
                      }
                    />
                  </td>
                  <td className={tableCellClass}>
                    <ApprovalModeBadge mode={batch.approvalMode} />
                  </td>
                  <td className={tableCellClass}>{batch.strategy}</td>
                  <td className={tableCellClass}>{formatDateTime(batch.createdAt)}</td>
                  <td className={tableCellClass}>
                    <div className="flex items-center gap-1">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={(event) => {
                          event.stopPropagation();
                          triggerUpload(batch.id);
                        }}
                        disabled={uploadFiles.isPending}
                      >
                        <UploadCloud size={14} />
                        上传
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={(event) => {
                          event.stopPropagation();
                          setDeleteTarget(batch);
                        }}
                        title="删除批次（含文档与识别结果）"
                        className="text-danger hover:text-danger"
                      >
                        <Trash2 size={14} />
                      </Button>
                      <ChevronRight size={16} className="text-muted-foreground" aria-hidden />
                    </div>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td className={tableCellClass} colSpan={9}>
                  <span className="text-muted-foreground">
                    {isLoading ? "加载中..." : "暂无批次，点击右上角新建批次"}
                  </span>
                </td>
              </tr>
            )}
          </tbody>
        </DataTable>
        <Pagination page={page} totalPages={totalPages} total={total} onPage={setPage} />
      </TableWrap>
      <Panel>
        <PanelHeader>
          <div className="flex items-center gap-2">
            <PackageOpen size={16} className="text-primary" />
            <PanelTitle>月份批次</PanelTitle>
            <span className="text-xs text-muted-foreground">共 {monthBatchData?.total ?? 0} 个</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="month"
              value={monthFilter}
              onChange={(event) => setMonthFilter(event.target.value)}
              className="h-8 rounded-md border border-border bg-surface px-2 text-xs outline-none focus:border-primary"
              aria-label="筛选月份批次"
            />
            {monthFilter ? (
              <Button size="icon" variant="ghost" onClick={() => setMonthFilter("")} title="清除月份筛选">
                <X size={14} />
              </Button>
            ) : null}
            <Button size="sm" variant="secondary" onClick={() => setCreateMonthOpen(true)}>
              <CalendarPlus size={14} />
              新建
            </Button>
          </div>
        </PanelHeader>
        <DataTable>
          <thead className={tableHeadClass}>
            <tr>
              <th className={tableCellClass}>名称</th>
              <th className={tableCellClass}>月份</th>
              <th className={tableCellClass}>包含批次</th>
              <th className={tableCellClass}>文档数</th>
              <th className={tableCellClass}>行数</th>
              <th className={tableCellClass}>创建时间</th>
              <th className={tableCellClass}>操作</th>
            </tr>
          </thead>
          <tbody>
            {monthBatches.length ? (
              monthBatches.map((monthBatch) => (
                <tr key={monthBatch.id} className="hover:bg-muted/70">
                  <td className={tableCellClass}>
                    <span className="font-medium text-foreground">{monthBatch.name}</span>
                  </td>
                  <td className={tableCellClass}>{formatMonth(monthBatch.month)}</td>
                  <td className={tableCellClass}>
                    <div className="flex max-w-xl flex-wrap gap-1">
                      {monthBatch.batches.slice(0, 4).map((batch) => (
                        <Badge key={batch.id} tone="info" className="max-w-44 truncate" title={batch.name}>
                          {batch.name}
                        </Badge>
                      ))}
                      {monthBatch.batchCount > 4 ? <Badge>+{monthBatch.batchCount - 4}</Badge> : null}
                      {!monthBatch.batchCount ? (
                        <span className="text-xs text-muted-foreground">未绑定批次</span>
                      ) : null}
                    </div>
                  </td>
                  <td className={tableCellClass}>{formatNumber(monthBatch.documentCount)}</td>
                  <td className={tableCellClass}>{formatNumber(monthBatch.rowCount)}</td>
                  <td className={tableCellClass}>{formatDateTime(monthBatch.createdAt)}</td>
                  <td className={tableCellClass}>
                    <div className="flex items-center gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditMonthTarget(monthBatch)}
                        title="编辑月份批次"
                      >
                        <Pencil size={14} />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setDeleteMonthTarget(monthBatch)}
                        title="删除月份批次（不删除普通批次）"
                        className="text-danger hover:text-danger"
                      >
                        <Trash2 size={14} />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td className={tableCellClass} colSpan={7}>
                  <span className="text-muted-foreground">
                    {monthBatchesLoading ? "加载中..." : "暂无月份批次，可将多个普通批次打包到一个月份。"}
                  </span>
                </td>
              </tr>
            )}
          </tbody>
        </DataTable>
      </Panel>
      <CreateBatchDrawer
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        defaultApprovalMode={settings?.defaults.approvalMode ?? "hybrid"}
        defaultStrategy={settings?.defaults.strategy ?? "balanced"}
        providers={settings?.providers ?? []}
        onSubmit={(payload) => createBatch.mutate(payload)}
      />
      <CreateMonthBatchDialog
        open={monthDialogOpen}
        initial={editMonthTarget}
        onClose={() => {
          if (monthDialogPending) return;
          setCreateMonthOpen(false);
          setEditMonthTarget(null);
        }}
        batches={batchOptions}
        pending={monthDialogPending}
        error={
          ((editMonthTarget ? updateMonthBatch.error : createMonthBatch.error) as Error | null)?.message ??
          null
        }
        onSubmit={(payload) => {
          if (editMonthTarget) updateMonthBatch.mutate({ id: editMonthTarget.id, payload });
          else createMonthBatch.mutate(payload);
        }}
      />
      <Dialog
        open={!!deleteTarget}
        onClose={() => !deleteBatch.isPending && setDeleteTarget(null)}
        title="删除批次"
        description="此操作不可撤销"
        className="max-w-md"
        footer={
          <>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setDeleteTarget(null)}
              disabled={deleteBatch.isPending}
            >
              取消
            </Button>
            <Button
              size="sm"
              variant="danger"
              onClick={() => deleteTarget && deleteBatch.mutate(deleteTarget.id)}
              disabled={deleteBatch.isPending}
            >
              <Trash2 size={14} />
              {deleteBatch.isPending ? "删除中..." : "确认删除"}
            </Button>
          </>
        }
      >
        <p className="text-sm text-foreground">
          确认删除批次「<span className="font-medium">{deleteTarget?.name}</span>」？
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          将一并删除该批次下的 {formatNumber(deleteTarget?._count?.documents ?? 0)} 个文档、
          {formatNumber(deleteTarget?._count?.rows ?? 0)} 行识别结果及对应原图文件，且无法恢复。
        </p>
        {deleteBatch.isError ? (
          <p className="mt-3 text-xs text-danger">{(deleteBatch.error as Error)?.message ?? "删除失败"}</p>
        ) : null}
      </Dialog>
      <Dialog
        open={!!deleteMonthTarget}
        onClose={() => !deleteMonthBatch.isPending && setDeleteMonthTarget(null)}
        title="删除月份批次"
        description="普通批次不会被删除"
        className="max-w-md"
        footer={
          <>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setDeleteMonthTarget(null)}
              disabled={deleteMonthBatch.isPending}
            >
              取消
            </Button>
            <Button
              size="sm"
              variant="danger"
              onClick={() => deleteMonthTarget && deleteMonthBatch.mutate(deleteMonthTarget.id)}
              disabled={deleteMonthBatch.isPending}
            >
              <Trash2 size={14} />
              {deleteMonthBatch.isPending ? "删除中..." : "确认删除"}
            </Button>
          </>
        }
      >
        <p className="text-sm text-foreground">
          确认删除月份批次「<span className="font-medium">{deleteMonthTarget?.name}</span>」？
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          仅删除打包关系，不影响其中的 {formatNumber(deleteMonthTarget?.batchCount ?? 0)} 个普通批次。
        </p>
        {deleteMonthBatch.isError ? (
          <p className="mt-3 text-xs text-danger">
            {(deleteMonthBatch.error as Error)?.message ?? "删除失败"}
          </p>
        ) : null}
      </Dialog>
    </div>
  );
}

/** 批次审核进度：已确认行 / 总行的小进度条；无行时显示占位符。 */
function BatchProgressCell({
  progress,
  unfinishedDocuments,
  onOpenDocument,
}: {
  progress?: { total: number; confirmed: number; conflict: number };
  unfinishedDocuments: UnfinishedDocument[];
  onOpenDocument: (document: UnfinishedDocument) => void;
}) {
  const total = progress?.total ?? 0;
  const confirmed = progress?.confirmed ?? 0;
  if (total === 0) return <span className="text-xs text-muted-foreground">—</span>;
  const pct = Math.round((confirmed / total) * 100);
  const remaining = Math.max(0, total - confirmed);
  return (
    <div className="min-w-72 space-y-2">
      <div className="flex items-center gap-2">
        <span className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
          <span className="block h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
        </span>
        <span className="text-xs text-muted-foreground">
          {formatNumber(confirmed)}/{formatNumber(total)}
        </span>
        {remaining > 0 ? (
          <span className="text-xs text-warning-strong">待审 {formatNumber(remaining)}</span>
        ) : null}
      </div>
      {unfinishedDocuments.length ? (
        <div className="space-y-1">
          {unfinishedDocuments.slice(0, 3).map((document) => (
            <button
              key={document.id}
              type="button"
              className="flex w-full max-w-96 items-center gap-2 rounded-md border border-warning/30 bg-warning-soft px-2 py-1 text-left text-[11px] text-warning-strong transition-colors hover:border-warning hover:bg-warning/15"
              title={`打开 ${document.originalName}，定位到第 ${document.firstRowIndex + 1} 行`}
              onClick={(event) => {
                event.stopPropagation();
                onOpenDocument(document);
              }}
            >
              <FileSearch size={13} className="shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{document.originalName}</span>
                <span className="block truncate text-muted-foreground">
                  {formatNumber(document.pendingRows)} 行未审 · 第 {document.firstRowIndex + 1} 行{" "}
                  {document.firstRowCode ? `${document.firstRowCode} ` : ""}
                  {document.firstRowName}
                </span>
              </span>
            </button>
          ))}
          {unfinishedDocuments.length > 3 ? (
            <span className="block text-[11px] text-muted-foreground">
              另有 {formatNumber(unfinishedDocuments.length - 3)} 张单据未完成
            </span>
          ) : null}
        </div>
      ) : remaining > 0 ? (
        <span className="block text-[11px] text-muted-foreground">有未确认行，进入审核台查看</span>
      ) : null}
    </div>
  );
}

function currentMonthValue() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function mergeBatchOptions(primary: BatchPickerOption[], extra: BatchPickerOption[]) {
  const map = new Map<string, BatchPickerOption>();
  for (const batch of [...extra, ...primary]) map.set(batch.id, batch);
  return [...map.values()];
}

function formatMonth(month: string) {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  return match ? `${match[1]}年${Number(match[2])}月` : month;
}

function CreateMonthBatchDialog({
  open,
  initial,
  onClose,
  batches,
  pending,
  error,
  onSubmit,
}: {
  open: boolean;
  initial?: ApiMonthBatch | null;
  onClose: () => void;
  batches: BatchPickerOption[];
  pending: boolean;
  error: string | null;
  onSubmit: (payload: MonthBatchPayload) => void;
}) {
  const initialBatchIds = new Set(initial?.batches.map((batch) => batch.id) ?? []);
  const selectedCount = initialBatchIds.size;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={initial ? "编辑月份批次" : "新建月份批次"}
      description={initial ? "调整月份批次信息和包含批次" : "将多个普通批次打包到同一个月份"}
      className="max-w-2xl"
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          onSubmit({
            name: String(form.get("name") ?? ""),
            month: String(form.get("month") ?? ""),
            notes: String(form.get("notes") ?? ""),
            batchIds: form.getAll("batchIds").map(String),
          });
        }}
      >
        <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
          <label className="block text-sm">
            <span className="mb-1 block text-muted-foreground">名称</span>
            <input
              name="name"
              defaultValue={initial?.name ?? ""}
              className="h-9 w-full rounded-md border border-border px-3"
              placeholder="留空则按月份命名"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-muted-foreground">月份</span>
            <input
              name="month"
              type="month"
              required
              defaultValue={initial?.month ?? currentMonthValue()}
              className="h-9 w-full rounded-md border border-border px-3"
            />
          </label>
        </div>
        <label className="block text-sm">
          <span className="mb-1 block text-muted-foreground">备注</span>
          <textarea
            name="notes"
            defaultValue={initial?.notes ?? ""}
            className="min-h-16 w-full rounded-md border border-border px-3 py-2"
          />
        </label>
        <div className="rounded-md border border-border">
          <div className="flex items-center justify-between border-b border-border px-3 py-2 text-sm font-medium">
            <span>选择批次</span>
            {initial ? (
              <span className="text-xs font-normal text-muted-foreground">当前 {selectedCount} 个</span>
            ) : null}
          </div>
          <div className="max-h-72 divide-y divide-border overflow-auto">
            {batches.length ? (
              batches.map((batch) => (
                <label
                  key={batch.id}
                  className="flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-sm hover:bg-muted"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{batch.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {formatNumber(batch._count?.documents ?? 0)} 文档 ·{" "}
                      {formatNumber(batch._count?.rows ?? 0)} 行
                    </span>
                  </span>
                  <input
                    name="batchIds"
                    value={batch.id}
                    type="checkbox"
                    defaultChecked={initialBatchIds.has(batch.id)}
                    className="h-4 w-4 shrink-0"
                  />
                </label>
              ))
            ) : (
              <div className="px-3 py-8 text-center text-sm text-muted-foreground">暂无可选择批次</div>
            )}
          </div>
        </div>
        {error ? <p className="text-xs text-danger">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            取消
          </Button>
          <Button type="submit" variant="primary" disabled={pending}>
            <CalendarPlus size={15} />
            {pending ? "保存中..." : initial ? "保存" : "创建"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
