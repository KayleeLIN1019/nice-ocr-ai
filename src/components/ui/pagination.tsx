"use client";

/** 列表分页页脚（与全部结果表保持一致）。 */
export function Pagination({
  page,
  totalPages,
  total,
  onPage,
}: {
  page: number;
  totalPages: number;
  total: number;
  onPage: (page: number) => void;
}) {
  return (
    <div className="flex items-center justify-between border-t border-border px-4 py-3 text-xs text-muted-foreground">
      <span>共 {total} 条，第 {page} / {totalPages} 页</span>
      <div className="flex items-center gap-1">
        <button
          className="h-7 min-w-7 rounded border border-border bg-surface px-2 hover:bg-muted disabled:opacity-50"
          onClick={() => onPage(Math.max(1, page - 1))}
          disabled={page <= 1}
        >
          上一页
        </button>
        <button
          className="h-7 min-w-7 rounded border border-border bg-surface px-2 hover:bg-muted disabled:opacity-50"
          onClick={() => onPage(Math.min(totalPages, page + 1))}
          disabled={page >= totalPages}
        >
          下一页
        </button>
      </div>
    </div>
  );
}
