"use client";

import { AlertTriangle, Check, Plus, X } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Panel, PanelHeader, PanelTitle } from "@/components/ui/card";
import { severityLabel, severityTone } from "@/components/ui/reason-badge";
import { useRuleMap } from "@/lib/rules/use-rule-catalog";
import { apiGet } from "@/lib/api/client";
import { apiPaths } from "@/lib/api/paths";
import type { RecognitionRow } from "@/lib/types";

interface ExportTemplateInfo {
  id: string;
  name: string;
  description: string;
}

export interface BatchModelOptionProvider {
  providerKey: string;
  displayName: string;
  enabled: boolean;
  models: Array<{
    modelId: string;
    displayName: string;
    enabled: boolean;
  }>;
}

export interface CreateBatchPayload {
  name: string;
  strategy: string;
  notes: string;
  approvalMode: string;
  primaryProviderKey: string | null;
  primaryModelId: string | null;
  secondaryProviderKey: string | null;
  secondaryModelId: string | null;
  /** 绑定的导出模板 id；选模板后抽取与导出都走该模板（场景由后端按模板派生）。 */
  exportTemplateId: string | null;
}

export function DrawerShell({
  title,
  children,
  open,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  open: boolean;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/25">
      <aside className="h-full w-full max-w-md border-l border-border bg-surface shadow-xl">
        <div className="flex h-14 items-center justify-between border-b border-border px-4">
          <h2 className="text-sm font-semibold">{title}</h2>
          <Button size="icon" variant="ghost" aria-label="关闭" onClick={onClose}>
            <X size={16} />
          </Button>
        </div>
        <div className="p-4">{children}</div>
      </aside>
    </div>
  );
}

export function CreateBatchDrawer({
  open,
  onClose,
  onSubmit,
  defaultApprovalMode = "hybrid",
  defaultStrategy = "balanced",
  providers = [],
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (payload: CreateBatchPayload) => void;
  defaultApprovalMode?: string;
  defaultStrategy?: string;
  providers?: BatchModelOptionProvider[];
}) {
  const { data: templateData } = useQuery<{ templates: ExportTemplateInfo[] }>({
    queryKey: ["export-templates"],
    queryFn: () => apiGet(apiPaths.exportsTemplates),
    staleTime: 10 * 60 * 1000,
    enabled: open,
  });
  const templates = templateData?.templates ?? [];
  return (
    <DrawerShell title="创建批次" open={open} onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          onSubmit({
            name: String(form.get("name") ?? ""),
            strategy: String(form.get("strategy") ?? defaultStrategy),
            notes: String(form.get("notes") ?? ""),
            approvalMode: String(form.get("approvalMode") ?? "hybrid"),
            ...parseProviderModelSelection(String(form.get("primaryTarget") ?? "")),
            ...parseSecondaryProviderModelSelection(String(form.get("secondaryTarget") ?? "")),
            exportTemplateId: String(form.get("exportTemplateId") ?? "") || null,
          });
        }}
      >
        <label className="block text-sm">
          <span className="mb-1 block text-muted-foreground">批次名称</span>
          <input name="name" required className="h-9 w-full rounded-md border border-border px-3" placeholder="2024-06 销售单据批次" />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-muted-foreground">审批模式</span>
          <select name="approvalMode" defaultValue={defaultApprovalMode} className="h-9 w-full rounded-md border border-border bg-surface px-3">
            <option value="manual">全人工：所有行人工确认</option>
            <option value="hybrid">混合：双次一致+低风险自动通过，其余转人工</option>
            <option value="auto">AI自动：双次一致即自动通过，高风险转人工</option>
          </select>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-muted-foreground">识别策略</span>
          <select name="strategy" defaultValue={defaultStrategy} className="h-9 w-full rounded-md border border-border bg-surface px-3">
            <option value="balanced">balanced：有自动通过候选时二次识别</option>
            <option value="fast">fast：单次识别</option>
            <option value="consensus">consensus：全量多次识别</option>
            <option value="manual">manual：人工导入</option>
          </select>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-muted-foreground">主模型（pass1）</span>
          <select name="primaryTarget" className="h-9 w-full rounded-md border border-border bg-surface px-3">
            <option value="">继承全局默认</option>
            {renderModelOptions(providers)}
          </select>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-muted-foreground">副模型（pass2）</span>
          <select name="secondaryTarget" className="h-9 w-full rounded-md border border-border bg-surface px-3">
            <option value="">继承全局默认</option>
            {renderModelOptions(providers)}
          </select>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-muted-foreground">导出模板</span>
          <select name="exportTemplateId" defaultValue="" className="h-9 w-full rounded-md border border-border bg-surface px-3">
            <option value="">不绑定（导出时再选）</option>
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-xs text-muted-foreground">
            绑定后，本批次的抽取与导出都按该模板的内容进行。
          </span>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-muted-foreground">备注</span>
          <textarea name="notes" className="min-h-24 w-full rounded-md border border-border px-3 py-2" />
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>取消</Button>
          <Button type="submit" variant="primary"><Plus size={15} />创建</Button>
        </div>
      </form>
    </DrawerShell>
  );
}

function renderModelOptions(providers: BatchModelOptionProvider[]) {
  return providers.flatMap((provider) =>
    provider.models.map((model) => (
      <option key={`${provider.providerKey}::${model.modelId}`} value={`${provider.providerKey}::${model.modelId}`}>
        {(provider.displayName || provider.providerKey)} · {model.displayName || model.modelId}
        {provider.enabled && model.enabled ? "" : "（未启用）"}
      </option>
    )),
  );
}

function parseProviderModelSelection(value: string) {
  const [providerKey, ...modelParts] = value.split("::");
  const modelId = modelParts.join("::");
  return {
    primaryProviderKey: providerKey && modelId ? providerKey : null,
    primaryModelId: providerKey && modelId ? modelId : null,
  };
}

function parseSecondaryProviderModelSelection(value: string) {
  const [providerKey, ...modelParts] = value.split("::");
  const modelId = modelParts.join("::");
  return {
    secondaryProviderKey: providerKey && modelId ? providerKey : null,
    secondaryModelId: providerKey && modelId ? modelId : null,
  };
}

export function EditRowDrawer({
  row,
  open,
  onClose,
  onSubmit,
}: {
  row?: RecognitionRow;
  open: boolean;
  onClose: () => void;
  onSubmit: (payload: Partial<RecognitionRow>) => void;
}) {
  return (
    <DrawerShell title="编辑识别行" open={open} onClose={onClose}>
      {row ? (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            onSubmit({
              code: String(form.get("code") ?? ""),
              name: String(form.get("name") ?? ""),
              unit: String(form.get("unit") ?? ""),
              qty: Number(form.get("qty") ?? 0),
              price: Number(form.get("price") ?? 0),
              amount: Number(form.get("amount") ?? 0),
              remark: String(form.get("remark") ?? ""),
            });
          }}
        >
          {[
            ["code", "产品编码", row.code],
            ["name", "产品名称", row.name],
            ["unit", "单位", row.unit],
            ["qty", "数量", row.qty],
            ["price", "单价", row.price],
            ["amount", "金额", row.amount],
          ].map(([name, label, value]) => (
            <label key={String(name)} className="block text-sm">
              <span className="mb-1 block text-muted-foreground">{String(label)}</span>
              <input name={String(name)} defaultValue={String(value ?? "")} className="h-9 w-full rounded-md border border-border px-3" />
            </label>
          ))}
          <label className="block text-sm">
            <span className="mb-1 block text-muted-foreground">备注</span>
            <textarea name="remark" defaultValue={row.remark ?? ""} className="min-h-20 w-full rounded-md border border-border px-3 py-2" />
          </label>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={onClose}>取消</Button>
            <Button type="submit" variant="primary"><Check size={15} />保存</Button>
          </div>
        </form>
      ) : null}
    </DrawerShell>
  );
}

export function RiskDetailDrawer({
  open,
  onClose,
  reasons = [],
}: {
  open: boolean;
  onClose: () => void;
  /** 当前单据/行命中的原因码，逐条经规则字典翻成中文释义与处理建议。 */
  reasons?: string[];
}) {
  const { map } = useRuleMap();
  // 过滤被后台停用的规则（视为非问题）。
  const active = reasons.filter((code) => map.get(code)?.enabled !== false);
  return (
    <DrawerShell title="风险详情" open={open} onClose={onClose}>
      <Panel>
        <PanelHeader>
          <PanelTitle>命中的规则</PanelTitle>
          <AlertTriangle className="text-danger-strong" size={18} />
        </PanelHeader>
        <div className="space-y-3 p-4 text-sm">
          {active.length ? (
            active.map((code) => {
              const entry = map.get(code);
              const tone = entry ? severityTone[entry.severity] : "neutral";
              return (
                <div key={code} className="rounded-md border border-border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{entry?.label ?? code}</span>
                    <Badge tone={tone}>{entry ? `${severityLabel[entry.severity]}风险` : "未登记"}</Badge>
                  </div>
                  {entry?.description ? (
                    <p className="mt-1.5 text-muted-foreground">{entry.description}</p>
                  ) : (
                    <p className="mt-1.5 text-muted-foreground">该原因码（{code}）尚未在规则字典登记。</p>
                  )}
                  {entry?.suggestion ? (
                    <p className="mt-1.5 text-foreground">
                      <span className="text-muted-foreground">处理建议：</span>
                      {entry.suggestion}
                    </p>
                  ) : null}
                </div>
              );
            })
          ) : (
            <div className="rounded-md bg-success-soft p-3 text-success-strong">该单据未命中任何风险规则。</div>
          )}
          <div className="rounded-md bg-muted p-3 text-muted-foreground">
            规则释义可在「系统 · 规则字典」中维护。高风险行不会被自动确认，需要人工审核。
          </div>
        </div>
      </Panel>
    </DrawerShell>
  );
}
