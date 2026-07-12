"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  AlertTriangle,
  BadgeCheck,
  Boxes,
  BookCheck,
  Database,
  FileImage,
  FileInput,
  LayoutDashboard,
  ListChecks,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  Table2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { apiGet } from "@/lib/api/client";
import { apiPaths } from "@/lib/api/paths";
import { SidebarProvider } from "./sidebar-context";

const navGroups = [
  {
    label: "工作区",
    items: [
      { href: "/", label: "仪表盘", icon: LayoutDashboard },
      { href: "/batches", label: "批次管理", icon: Boxes },
      { href: "/results", label: "全部结果", icon: Table2 },
      { href: "/review", label: "审核工作台", icon: FileImage },
    ],
  },
  {
    label: "数据",
    items: [
      { href: "/products", label: "产品库", icon: Database },
      { href: "/conflicts", label: "冲突管理", icon: AlertTriangle },
    ],
  },
  {
    label: "系统",
    items: [
      { href: "/queue", label: "队列", icon: ListChecks },
      { href: "/import", label: "导入", icon: FileInput },
      { href: "/rules", label: "规则字典", icon: BookCheck },
      { href: "/settings", label: "设置", icon: Settings },
    ],
  },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  // 折叠时鼠标悬停自动展开（浮层覆盖正文，不挤动布局）。expanded=有效展开态。
  const [hovered, setHovered] = useState(false);
  const expanded = !collapsed || hovered;

  // 折叠状态持久化（localStorage），初值 false 以避免 SSR/CSR 水合不一致，挂载后再同步。
  useEffect(() => {
    if (typeof window !== "undefined" && window.localStorage.getItem("sidebar-collapsed") === "1") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 挂载后读取持久化偏好，水合安全
      setCollapsed(true);
    }
  }, []);

  function toggleCollapsed() {
    setCollapsed((current) => {
      const next = !current;
      if (typeof window !== "undefined") window.localStorage.setItem("sidebar-collapsed", next ? "1" : "0");
      return next;
    });
  }

  const { data: summary } = useQuery<{ metrics: { queued: number } }>({
    queryKey: ["dashboard"],
    queryFn: () => apiGet(apiPaths.dashboardSummary),
  });

  const queued = summary?.metrics.queued ?? 0;

  // 顶栏面包屑：由当前路由匹配侧栏导航推导「分区 · 当前页」，作为上下文 chrome。
  const activeNav = navGroups
    .flatMap((group) => group.items.map((item) => ({ ...item, group: group.label })))
    .find((item) => (item.href === "/" ? pathname === "/" : pathname.startsWith(item.href)));

  return (
    <SidebarProvider value={{ collapsed, setCollapsed }}>
    <div className="relative flex h-screen overflow-hidden bg-app text-foreground">
      {/* 折叠时的占位条：保持正文位置，让悬停浮层覆盖在其上而不挤动布局 */}
      {collapsed ? <div className="hidden w-16 shrink-0 lg:block" aria-hidden /> : null}
      <aside
        onMouseEnter={() => collapsed && setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        className={cn(
          "hidden h-screen shrink-0 flex-col overflow-y-auto border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width] duration-200 lg:flex",
          expanded ? "w-60" : "w-16",
          collapsed ? "absolute left-0 top-0 z-40" : "",
          collapsed && hovered ? "shadow-xl" : "",
        )}
      >
        <div
          className={cn(
            "flex h-14 shrink-0 items-center border-b border-sidebar-border",
            expanded ? "gap-2 px-4" : "justify-center px-0",
          )}
        >
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary text-sm font-bold text-primary-foreground">
            N
          </div>
          {expanded ? (
            <div>
              <div className="text-sm font-semibold text-foreground">nice-ocr</div>
              <div className="text-[11px] text-sidebar-muted">智能单据识别</div>
            </div>
          ) : null}
        </div>
        <nav className={cn("space-y-5 py-4", expanded ? "px-3" : "px-2")}>
          {navGroups.map((group) => (
            <div key={group.label}>
              {expanded ? (
                <div className="mb-2 px-2 text-[11px] font-medium text-sidebar-muted">{group.label}</div>
              ) : (
                <div className="mb-2 h-px bg-sidebar-border" />
              )}
              <div className="space-y-1">
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      title={expanded ? undefined : item.label}
                      className={cn(
                        "flex h-9 items-center rounded-md text-sm transition-colors",
                        expanded ? "gap-2 px-2" : "justify-center px-0",
                        active
                          ? "bg-primary/10 font-medium text-primary"
                          : "text-sidebar-foreground hover:bg-sidebar-hover hover:text-foreground",
                      )}
                    >
                      <Icon size={16} />
                      {expanded ? <span>{item.label}</span> : null}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>
      </aside>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border bg-surface px-4">
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              onClick={toggleCollapsed}
              aria-label={collapsed ? "展开侧边栏" : "折叠侧边栏"}
              title={collapsed ? "展开侧边栏" : "折叠侧边栏"}
              className="hidden h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:flex"
            >
              {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
            </button>
            <nav aria-label="面包屑" className="flex min-w-0 items-center gap-2 text-sm">
              {activeNav ? (
              <>
                <span className="shrink-0 text-muted-foreground">{activeNav.group}</span>
                <span className="shrink-0 text-border">/</span>
                <span className="truncate font-medium text-foreground">{activeNav.label}</span>
              </>
              ) : (
                <span className="font-medium text-foreground">nice-ocr</span>
              )}
            </nav>
          </div>
          <div className="flex items-center gap-2">
            <div className="hidden items-center gap-1.5 rounded-md border border-info/30 bg-info-soft px-2.5 py-1.5 text-xs font-medium text-info-strong sm:flex">
              <BadgeCheck size={14} />
              公开演示版 · 脱敏数据
            </div>
            <Link
              href="/queue"
              title="查看识别队列"
              className="hidden items-center gap-2 rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-foreground md:flex"
            >
              <span className={cn("h-2 w-2 rounded-full", queued > 0 ? "bg-warning" : "bg-success")} />
              {queued > 0 ? `队列处理中 ${queued}` : "队列空闲"}
            </Link>
          </div>
        </header>
        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-4">{children}</main>
      </div>
    </div>
    </SidebarProvider>
  );
}
