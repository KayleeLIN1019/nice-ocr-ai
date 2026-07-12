"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { apiGet } from "@/lib/api/client";
import { apiPaths } from "@/lib/api/paths";
import type { RuleCategory, RuleSeverity } from "@/lib/rules/catalog-defaults";

export interface RuleCatalogEntry {
  id: string;
  code: string;
  category: RuleCategory;
  label: string;
  description: string;
  suggestion: string;
  severity: RuleSeverity;
  enabled: boolean;
  sortOrder: number;
  builtin: boolean;
}

export interface RuleCatalogPayload {
  rules: RuleCatalogEntry[];
  categoryLabels: Record<string, string>;
}

/** 拉取整本规则字典，驱动审核台/冲突页/后台的中文释义渲染。 */
export function useRuleCatalog() {
  return useQuery<RuleCatalogPayload>({
    queryKey: ["rules"],
    queryFn: () => apiGet(apiPaths.rules),
    staleTime: 5 * 60 * 1000,
  });
}

/** 把字典摊平成 code → entry 的 Map，便于展示组件按码取释义。 */
export function useRuleMap() {
  const query = useRuleCatalog();
  const map = useMemo(() => {
    const result = new Map<string, RuleCatalogEntry>();
    for (const rule of query.data?.rules ?? []) result.set(rule.code, rule);
    return result;
  }, [query.data]);
  return { map, isLoading: query.isLoading };
}
