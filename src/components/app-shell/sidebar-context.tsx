"use client";

import { createContext, useContext } from "react";

/**
 * 侧边栏折叠状态共享：AppShell 持有 state 并 provide，深层页面（如审核台专注模式）
 * 借此联动折叠/展开侧边栏，无需提升状态或穿透 props。
 */
interface SidebarContextValue {
  collapsed: boolean;
  /** 直接设置折叠态（不写 localStorage，仅用于会话级联动，不污染用户持久偏好）。 */
  setCollapsed: (value: boolean) => void;
}

const SidebarContext = createContext<SidebarContextValue | null>(null);

export const SidebarProvider = SidebarContext.Provider;

/** 无 Provider 时返回安全空实现，便于组件在测试/独立渲染下不崩。 */
export function useSidebar(): SidebarContextValue {
  return useContext(SidebarContext) ?? { collapsed: false, setCollapsed: () => {} };
}
