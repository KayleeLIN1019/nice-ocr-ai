import type { HTMLAttributes, TableHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export function DataTable({ className, ...props }: TableHTMLAttributes<HTMLTableElement>) {
  return <table className={cn("w-full border-collapse text-left text-xs", className)} {...props} />;
}

export function TableWrap({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("overflow-hidden rounded-lg border border-border bg-surface shadow-sm", className)}
      {...props}
    />
  );
}

export const tableHeadClass =
  "sticky top-0 z-10 border-b border-border bg-table-header text-xs font-semibold text-table-header-foreground";

export const tableCellClass = "border-b border-border px-3 py-2 align-middle";
