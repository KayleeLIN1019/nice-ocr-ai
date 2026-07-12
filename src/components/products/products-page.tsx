"use client";

import { Download, RefreshCw, Upload } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DataTable, tableCellClass, tableHeadClass, TableWrap } from "@/components/ui/table";
import { Pagination } from "@/components/ui/pagination";
import { apiDownload, apiGet, apiJson, apiUpload } from "@/lib/api/client";
import { apiPaths } from "@/lib/api/paths";
import { formatDateTime } from "@/lib/utils";

interface ImportHistoryResult {
  products: number;
  historyRecords: number;
  productsCreated: number;
  productsUpdated: number;
  withCode: number;
}

interface ApiProduct {
  id: string;
  code?: string | null;
  name: string;
  unit?: string | null;
  aliasesJson?: string;
  conflicts?: Array<{ status: string; type: string; reason: string; sourceRowIdsJson?: string }>;
  observationCount: number;
  sourceDocuments: number;
  lastSeenAt?: string | null;
  updatedAt?: string;
}

function productConflictHref(product: ApiProduct, conflict: { type: string }) {
  const q = conflict.type === "CODE_NAME_CONFLICT" ? product.code : product.name;
  if (!q) return null;
  const params = new URLSearchParams({ q, searchMode: "exact" });
  return `/results?${params.toString()}`;
}

export function ProductsPage() {
  const queryClient = useQueryClient();
  const [q, setQ] = useState("");
  const [onlyConflicts, setOnlyConflicts] = useState(false);
  const [page, setPage] = useState(1);

  const PAGE_SIZE = 20;
  const queryString = (() => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (q) params.set("q", q);
    if (onlyConflicts) params.set("onlyConflicts", "true");
    return params.toString();
  })();

  const { data, isLoading } = useQuery<{ products: ApiProduct[]; total: number }>({
    queryKey: ["products", queryString],
    queryFn: () => apiGet(`${apiPaths.products}?${queryString}`),
  });
  const products = data?.products ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const rebuild = useMutation({
    mutationFn: () => apiJson(apiPaths.productsRebuild, { method: "POST", body: JSON.stringify({}) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["products"] }),
  });
  const exportProducts = useMutation({ mutationFn: () => apiDownload(apiPaths.exportsProducts) });

  // 历史记录导入：上传采购统计表，写入产品库 + #3 历史校验基线。
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const importHistory = useMutation({
    mutationFn: (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      return apiUpload<ImportHistoryResult>(apiPaths.importHistory, formData);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["products"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
  const importError = (importHistory.error as Error)?.message ?? null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">产品库</h1>
          <p className="mt-1 text-sm text-muted-foreground">从识别明细沉淀产品资料，并维护编码、名称、单位冲突。</p>
          {importHistory.isPending ? (
            <p className="mt-1 text-xs text-info-strong">正在导入历史记录，请稍候（大文件可能需要数十秒）…</p>
          ) : importHistory.data ? (
            <p className="mt-1 text-xs text-success-strong">
              导入完成：解析 {importHistory.data.products} 个产品，新增 {importHistory.data.productsCreated}、更新{" "}
              {importHistory.data.productsUpdated}，写入历史基线 {importHistory.data.historyRecords} 条。
            </p>
          ) : importError ? (
            <p className="mt-1 text-xs text-danger">导入失败：{importError}</p>
          ) : null}
        </div>
        <div className="flex gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) importHistory.mutate(file);
              event.target.value = "";
            }}
          />
          <Button
            size="sm"
            variant="secondary"
            onClick={() => fileInputRef.current?.click()}
            disabled={importHistory.isPending}
            title="导入采购统计表（.xlsx）：写入产品库并作为单位历史校验基线"
          >
            <Upload size={15} className={importHistory.isPending ? "animate-pulse" : undefined} />导入历史
          </Button>
          <Button size="sm" variant="secondary" onClick={() => rebuild.mutate()} disabled={rebuild.isPending}>
            <RefreshCw size={15} className={rebuild.isPending ? "animate-spin" : undefined} />重建产品库
          </Button>
          <Button size="sm" variant="primary" onClick={() => exportProducts.mutate()} disabled={exportProducts.isPending}>
            <Download size={15} />导出
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface p-3">
        <input
          className="h-9 w-72 rounded-md border border-border px-3 text-sm"
          placeholder="搜索产品名/编码"
          value={q}
          onChange={(event) => {
            setQ(event.target.value);
            setPage(1);
          }}
        />
        <label className="inline-flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            className="h-4 w-4"
            checked={onlyConflicts}
            onChange={(event) => {
              setOnlyConflicts(event.target.checked);
              setPage(1);
            }}
          />
          仅看冲突
        </label>
        <span className="text-xs text-muted-foreground">共 {total} 个产品</span>
      </div>

      <TableWrap>
        <DataTable>
          <thead className={tableHeadClass}>
            <tr>
              <th className={tableCellClass}>产品编码</th>
              <th className={tableCellClass}>产品名</th>
              <th className={tableCellClass}>单位</th>
              <th className={tableCellClass}>别名</th>
              <th className={tableCellClass}>出现次数</th>
              <th className={tableCellClass}>来源文档</th>
              <th className={tableCellClass}>最近出现</th>
              <th className={tableCellClass}>冲突</th>
            </tr>
          </thead>
          <tbody>
            {products.length ? (
              products.map((product) => {
                const aliases = product.aliasesJson ? safeParseArray(product.aliasesJson) : [];
                const openConflicts = product.conflicts?.filter((conflict) => conflict.status === "open") ?? [];
                return (
                  <tr key={product.id} className="hover:bg-muted/70">
                    <td className={tableCellClass}>{product.code || "-"}</td>
                    <td className={tableCellClass}>{product.name}</td>
                    <td className={tableCellClass}>{product.unit || "-"}</td>
                    <td className={tableCellClass}>{aliases.join("、") || "-"}</td>
                    <td className={tableCellClass}>{product.observationCount}</td>
                    <td className={tableCellClass}>{product.sourceDocuments}</td>
                    <td className={tableCellClass}>{formatDateTime(product.lastSeenAt ?? product.updatedAt)}</td>
                    <td className={tableCellClass}>
                      {openConflicts.length ? (
                        <div className="flex max-w-96 flex-wrap gap-1">
                          {openConflicts.map((conflict) => {
                            const href = productConflictHref(product, conflict);
                            const badge = (
                              <Badge
                                tone={conflict.type === "CODE_NAME_CONFLICT" ? "danger" : "warning"}
                                className="max-w-64 truncate"
                                title={`${conflict.reason}，点击查看识别明细`}
                              >
                                {conflict.reason}
                              </Badge>
                            );
                            return href ? (
                              <Link key={`${conflict.type}-${conflict.reason}`} href={href}>
                                {badge}
                              </Link>
                            ) : (
                              <span key={`${conflict.type}-${conflict.reason}`}>{badge}</span>
                            );
                          })}
                        </div>
                      ) : (
                        <Badge tone="success">正常</Badge>
                      )}
                    </td>
                  </tr>
                );
              })
            ) : (
              <tr>
                <td className={tableCellClass} colSpan={8}>
                  <span className="text-muted-foreground">{isLoading ? "加载中..." : "暂无产品，请先重建产品库"}</span>
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

function safeParseArray(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
