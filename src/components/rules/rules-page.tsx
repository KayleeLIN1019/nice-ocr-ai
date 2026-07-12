"use client";

import { RotateCcw, Save } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Panel, PanelHeader, PanelTitle } from "@/components/ui/card";
import { DataTable, tableCellClass, tableHeadClass } from "@/components/ui/table";
import { severityLabel, severityTone } from "@/components/ui/reason-badge";
import { apiGet, apiJson } from "@/lib/api/client";
import { apiPaths } from "@/lib/api/paths";
import type { RuleSeverity } from "@/lib/rules/catalog-defaults";
import type { RuleCatalogEntry, RuleCatalogPayload } from "@/lib/rules/use-rule-catalog";

const SEVERITIES: RuleSeverity[] = ["low", "medium", "high"];

export function RulesPage() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery<RuleCatalogPayload>({
    queryKey: ["rules"],
    queryFn: () => apiGet(apiPaths.rules),
  });

  const grouped = useMemo(() => {
    const map = new Map<string, RuleCatalogEntry[]>();
    for (const rule of data?.rules ?? []) {
      map.set(rule.category, [...(map.get(rule.category) ?? []), rule]);
    }
    return map;
  }, [data]);

  const categoryLabels = data?.categoryLabels ?? {};

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">规则字典</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          维护识别校验、产品库冲突、二次审核与模型异常的中文释义、严重度与处理建议。改动即时生效于审核台、冲突管理与仪表盘。
        </p>
      </div>

      {isLoading ? (
        <Panel>
          <div className="px-4 py-16 text-center text-sm text-muted-foreground">加载中...</div>
        </Panel>
      ) : (
        Array.from(grouped.entries()).map(([category, rules]) => (
          <Panel key={category}>
            <PanelHeader>
              <PanelTitle>{categoryLabels[category] ?? category}</PanelTitle>
              <span className="text-xs text-muted-foreground">{rules.length} 条</span>
            </PanelHeader>
            <div className="overflow-auto">
              <DataTable>
                <thead className={tableHeadClass}>
                  <tr>
                    <th className={tableCellClass}>标识码</th>
                    <th className={tableCellClass}>中文名</th>
                    <th className={tableCellClass}>说明</th>
                    <th className={tableCellClass}>处理建议</th>
                    <th className={tableCellClass}>严重度</th>
                    <th className={tableCellClass}>状态</th>
                    <th className={tableCellClass}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {rules.map((rule) => (
                    <RuleRow
                      key={rule.id}
                      rule={rule}
                      onChanged={() => queryClient.invalidateQueries({ queryKey: ["rules"] })}
                    />
                  ))}
                </tbody>
              </DataTable>
            </div>
          </Panel>
        ))
      )}
    </div>
  );
}

interface RuleDraft {
  label: string;
  description: string;
  suggestion: string;
  severity: RuleSeverity;
}

function toDraft(rule: RuleCatalogEntry): RuleDraft {
  return {
    label: rule.label,
    description: rule.description,
    suggestion: rule.suggestion,
    severity: rule.severity,
  };
}

function RuleRow({ rule, onChanged }: { rule: RuleCatalogEntry; onChanged: () => void }) {
  const [draft, setDraft] = useState<RuleDraft>(() => toDraft(rule));

  const dirty =
    draft.label !== rule.label ||
    draft.description !== rule.description ||
    draft.suggestion !== rule.suggestion ||
    draft.severity !== rule.severity;

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiJson(apiPaths.rule(rule.id), { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: onChanged,
  });

  function save() {
    patch.mutate({
      label: draft.label.trim() || rule.label,
      description: draft.description,
      suggestion: draft.suggestion,
      severity: draft.severity,
    });
  }

  function reset() {
    patch.mutate({ reset: true }, { onSuccess: () => onChanged() });
  }

  const inputClass =
    "h-8 w-full min-w-32 rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-primary";

  return (
    <tr className="align-top hover:bg-muted/40">
      <td className={tableCellClass}>
        <code className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{rule.code}</code>
      </td>
      <td className={tableCellClass}>
        <input
          className={inputClass}
          value={draft.label}
          onChange={(event) => setDraft((prev) => ({ ...prev, label: event.target.value }))}
          maxLength={40}
        />
      </td>
      <td className={tableCellClass}>
        <textarea
          className={`${inputClass} min-h-14 py-1.5`}
          value={draft.description}
          onChange={(event) => setDraft((prev) => ({ ...prev, description: event.target.value }))}
          maxLength={400}
        />
      </td>
      <td className={tableCellClass}>
        <textarea
          className={`${inputClass} min-h-14 py-1.5`}
          value={draft.suggestion}
          onChange={(event) => setDraft((prev) => ({ ...prev, suggestion: event.target.value }))}
          maxLength={400}
        />
      </td>
      <td className={tableCellClass}>
        <select
          className="h-8 rounded-md border border-border bg-surface px-2 text-xs outline-none focus:border-primary"
          value={draft.severity}
          onChange={(event) => setDraft((prev) => ({ ...prev, severity: event.target.value as RuleSeverity }))}
        >
          {SEVERITIES.map((value) => (
            <option key={value} value={value}>
              {severityLabel[value]}
            </option>
          ))}
        </select>
        <div className="mt-1">
          <Badge tone={severityTone[draft.severity]}>{severityLabel[draft.severity]}风险</Badge>
        </div>
      </td>
      <td className={tableCellClass}>
        <button
          type="button"
          onClick={() => patch.mutate({ enabled: !rule.enabled })}
          disabled={patch.isPending}
          title={rule.enabled ? "点击停用：停用后该原因在前端不再作为问题展示" : "点击启用"}
          className={`rounded-full px-2.5 py-0.5 text-[11px] transition-colors ${
            rule.enabled
              ? "bg-success-soft text-success-strong"
              : "bg-muted text-muted-foreground"
          }`}
        >
          {rule.enabled ? "启用中" : "已停用"}
        </button>
      </td>
      <td className={tableCellClass}>
        <div className="flex gap-1">
          <Button size="sm" variant="primary" onClick={save} disabled={patch.isPending || !dirty} title="保存改动">
            <Save size={14} />保存
          </Button>
          {rule.builtin ? (
            <Button size="sm" variant="ghost" onClick={reset} disabled={patch.isPending} title="重置为代码默认释义">
              <RotateCcw size={14} />重置
            </Button>
          ) : null}
        </div>
      </td>
    </tr>
  );
}
