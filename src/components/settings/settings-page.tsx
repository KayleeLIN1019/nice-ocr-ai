"use client";

import { Download, Plus, Save, Settings2, TestTube2, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiGet, apiJson } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Panel, PanelHeader, PanelTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type Protocol = "openai_responses" | "anthropic_messages";
type Strategy = "fast" | "balanced" | "consensus" | "manual";
type ApprovalMode = "manual" | "hybrid" | "auto";
type ModelSource = "manual" | "imported";

interface SettingsPayload {
  defaults: {
    strategy: Strategy;
    approvalMode: ApprovalMode;
    amountTolerance: number;
    queueConcurrency: number;
    maxAttempts: number;
    backoffSeconds: number;
    pdfRenderScale: number;
    primaryProviderKey: string | null;
    primaryModelId: string | null;
    secondaryProviderKey: string | null;
    secondaryModelId: string | null;
    systemPrompt: string;
    userPrompt: string;
    auditSampleRate: number;
    auditProviderKey: string | null;
    auditModelId: string | null;
  };
  providers: ProviderForm[];
}

interface ProviderModelForm {
  id?: string;
  providerId?: string;
  modelId: string;
  displayName: string;
  enabled: boolean;
  priority: number;
  source: ModelSource;
  metadataJson: string;
}

interface ProviderForm {
  id?: string;
  providerKey: string;
  displayName: string;
  protocol: Protocol;
  baseUrl: string;
  enabled: boolean;
  priority: number;
  temperature: number | null;
  maxOutputTokens: number;
  systemPrompt: string | null;
  userPrompt: string | null;
  metadataJson: string;
  hasApiKey?: boolean;
  apiKey?: string;
  models: ProviderModelForm[];
}

type SelectionPatch = {
  providerKey: string | null;
  modelId: string | null;
};

const protocolOptions: Array<{ value: Protocol; label: string }> = [
  { value: "openai_responses", label: "OpenAI Responses" },
  { value: "anthropic_messages", label: "Anthropic Messages" },
];

const defaultProvider: ProviderForm = {
  providerKey: "custom-provider",
  displayName: "自定义 Provider",
  protocol: "openai_responses",
  baseUrl: "https://api.openai.com/v1",
  enabled: false,
  priority: 100,
  temperature: null,
  maxOutputTokens: 2000,
  systemPrompt: null,
  userPrompt: null,
  metadataJson: "{}",
  models: [
    {
      modelId: "gpt-4.1",
      displayName: "GPT-4.1",
      enabled: true,
      priority: 100,
      source: "manual",
      metadataJson: "{}",
    },
  ],
};

export function SettingsPage() {
  const { data, isLoading, refetch } = useQuery({
    queryKey: ["settings"],
    queryFn: () => apiGet<SettingsPayload>("/api/settings"),
  });
  const [draft, setDraft] = useState<SettingsPayload | null>(null);
  const [syncedFrom, setSyncedFrom] = useState<SettingsPayload | null>(null);
  const [testState, setTestState] = useState<Record<string, string>>({});
  const [importState, setImportState] = useState<Record<string, string>>({});
  const [editingKey, setEditingKey] = useState<string | null>(null);

  // 渲染期同步：拉到新设置时初始化可编辑副本，避免在 effect 内 setState 触发级联渲染。
  if (data && data !== syncedFrom) {
    setSyncedFrom(data);
    setDraft({
      defaults: normalizeDefaults(data.defaults),
      providers: data.providers.map((provider) => ({ ...provider, apiKey: "", models: provider.models ?? [] })),
    });
  }

  const enabledCount = useMemo(() => draft?.providers.filter((provider) => provider.enabled).length ?? 0, [draft]);
  const enabledModelCount = useMemo(
    () => draft?.providers.reduce((sum, provider) => sum + provider.models.filter((model) => model.enabled).length, 0) ?? 0,
    [draft],
  );

  const saveMutation = useMutation({
    mutationFn: (payload: SettingsPayload) =>
      apiJson<SettingsPayload>("/api/settings", {
        method: "PUT",
        body: JSON.stringify({
          defaults: payload.defaults,
          providers: payload.providers.map((provider) => ({
            ...provider,
            apiKey: provider.apiKey?.trim() ? provider.apiKey : undefined,
            models: provider.models.filter((model) => model.modelId.trim()),
          })),
        }),
      }),
    onSuccess: async () => {
      await refetch();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiJson<{ id: string }>(`/api/settings/providers/${id}`, { method: "DELETE" }),
    onSuccess: async () => {
      setEditingKey(null);
      await refetch();
    },
  });

  if (isLoading || !draft) {
    return <div className="text-sm text-muted-foreground">加载设置中...</div>;
  }

  return (
    <div data-i18n-system className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">设置</h1>
          <p className="mt-1 text-sm text-muted-foreground">配置识别策略、AI provider、队列重试和校验规则。</p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <div className="flex items-center gap-2">
            <Badge tone={enabledCount > 0 ? "success" : "danger"}>{enabledCount} 个启用</Badge>
            <Badge tone={enabledModelCount > 0 ? "success" : "danger"}>{enabledModelCount} 个模型</Badge>
            <Button size="sm" variant="primary" onClick={() => saveMutation.mutate(draft)} disabled={saveMutation.isPending}>
              <Save size={15} />{saveMutation.isPending ? "保存中..." : "保存设置"}
            </Button>
          </div>
          {saveMutation.isError ? (
            <span className="text-xs text-danger">
              保存失败：{saveMutation.error instanceof Error ? saveMutation.error.message : String(saveMutation.error)}
            </span>
          ) : saveMutation.isSuccess ? (
            <span className="text-xs text-success">已保存</span>
          ) : null}
        </div>
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Panel>
          <PanelHeader><PanelTitle>识别策略</PanelTitle></PanelHeader>
          <div className="space-y-4 p-4">
            <label className="block text-sm">
              <span className="mb-1 block text-muted-foreground">默认模式</span>
              <select
                className="h-9 w-full rounded-md border border-border bg-surface px-3"
                value={draft.defaults.strategy}
                onChange={(event) => updateDefaults("strategy", event.target.value as Strategy)}
              >
                <option value="balanced">balanced：有自动通过候选时二次识别</option>
                <option value="fast">fast：单次识别</option>
                <option value="consensus">consensus：全量多次识别</option>
                <option value="manual">manual：人工导入/录入</option>
              </select>
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-muted-foreground">默认审批模式（新建批次继承）</span>
              <select
                className="h-9 w-full rounded-md border border-border bg-surface px-3"
                value={draft.defaults.approvalMode}
                onChange={(event) => updateDefaults("approvalMode", event.target.value as ApprovalMode)}
              >
                <option value="manual">全人工：所有行人工确认</option>
                <option value="hybrid">混合：双次一致+低风险自动通过，其余转人工</option>
                <option value="auto">AI自动：双次一致即自动通过，高风险转人工</option>
              </select>
            </label>
            <div className="grid gap-4 md:grid-cols-2">
              <NumberField label="金额容差" value={draft.defaults.amountTolerance} onChange={(value) => updateDefaults("amountTolerance", value)} />
              <NumberField label="并发数" value={draft.defaults.queueConcurrency} onChange={(value) => updateDefaults("queueConcurrency", value)} />
              <NumberField label="最大重试" value={draft.defaults.maxAttempts} onChange={(value) => updateDefaults("maxAttempts", value)} />
              <NumberField label="退避秒数" value={draft.defaults.backoffSeconds} onChange={(value) => updateDefaults("backoffSeconds", value)} />
              <NumberField label="PDF渲染倍率" value={draft.defaults.pdfRenderScale} onChange={(value) => updateDefaults("pdfRenderScale", value)} />
            </div>

            <div className="space-y-3 rounded-md border border-border bg-muted/40 p-3">
              <div className="text-sm font-medium">双模型交叉验证（新建批次继承）</div>
              <p className="text-xs text-muted-foreground">
                两次识别分别用主、副模型，两次一致才允许 AI 自动通过。副模型留空则自动选另一个启用模型，无其他可用时退化为主模型双跑。
              </p>
              <div className="grid gap-4 md:grid-cols-2">
                <ProviderModelSelect
                  label="主模型（pass1）"
                  providerKey={draft.defaults.primaryProviderKey}
                  modelId={draft.defaults.primaryModelId}
                  providers={draft.providers}
                  onChange={(value) => updateSelectionDefaults("primary", value)}
                />
                <ProviderModelSelect
                  label="副模型（pass2）"
                  providerKey={draft.defaults.secondaryProviderKey}
                  modelId={draft.defaults.secondaryModelId}
                  providers={draft.providers}
                  onChange={(value) => updateSelectionDefaults("secondary", value)}
                />
              </div>
            </div>

            <div className="space-y-3 rounded-md border border-border bg-muted/40 p-3">
              <div className="text-sm font-medium">审核（确认后二次复查）</div>
              <p className="text-xs text-muted-foreground">
                对「机器自动通过」的行做规则/统计预筛 + 第三次独立 AI 交叉验证，存疑行进复审队列交人工。手动在批次/审核台点「运行审核」触发。
              </p>
              <div className="grid gap-4 md:grid-cols-2">
                <ProviderModelSelect
                  label="审核模型（第三次复核）"
                  providerKey={draft.defaults.auditProviderKey}
                  modelId={draft.defaults.auditModelId}
                  providers={draft.providers}
                  onChange={(value) => updateSelectionDefaults("audit", value)}
                />
                <NumberField
                  label="干净行抽样率（0~1）"
                  value={draft.defaults.auditSampleRate}
                  onChange={(value) => updateDefaults("auditSampleRate", value)}
                />
              </div>
            </div>
          </div>
        </Panel>

        <Panel>
          <PanelHeader>
            <div className="flex items-center justify-between gap-3">
              <PanelTitle>AI Provider / 模型</PanelTitle>
              <Button size="sm" variant="secondary" onClick={addProvider}>
                <Plus size={15} />新增 Provider
              </Button>
            </div>
          </PanelHeader>
          <div className="p-4">
            {draft.providers.length ? (
              <div className="space-y-2.5">
                {draft.providers.map((provider, index) => {
                  const cardKey = provider.id ?? provider.providerKey;
                  const enabledModels = provider.models.filter((model) => model.enabled);
                  return (
                    <div
                      key={cardKey}
                      className={cn(
                        "flex flex-col gap-2.5 rounded-md border bg-surface p-3 transition-colors",
                        provider.enabled ? "border-border" : "border-dashed border-border",
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <span
                            className={cn(
                              "h-2 w-2 shrink-0 rounded-full",
                              provider.enabled ? "bg-success" : "bg-muted-foreground/40",
                            )}
                          />
                          <span className="truncate text-sm font-medium">{provider.displayName || provider.providerKey}</span>
                        </div>
                        <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                          <input
                            type="checkbox"
                            checked={provider.enabled}
                            onChange={(event) => updateProvider(index, { enabled: event.target.checked })}
                          />
                          启用
                        </label>
                      </div>

                      <div className="truncate text-xs text-muted-foreground" title={enabledModels.map((model) => model.modelId).join(", ")}>
                        {enabledModels.length ? enabledModels.map((model) => model.modelId).join(" / ") : "没有启用模型"}
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge>{protocolLabel(provider.protocol)}</Badge>
                        <Badge>{provider.models.length} models</Badge>
                        {provider.hasApiKey ? <Badge tone="success">已配密钥</Badge> : <Badge tone="danger">无密钥</Badge>}
                        <Button size="sm" variant="secondary" className="ml-auto" onClick={() => setEditingKey(cardKey)}>
                          <Settings2 size={14} />配置
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="rounded-md border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
                还没有配置 provider，点右上角「新增 Provider」添加。
              </div>
            )}
          </div>
        </Panel>
      </div>

      {renderProviderDialog()}

      <Panel>
        <PanelHeader><PanelTitle>全局识别提示词</PanelTitle></PanelHeader>
        <div className="space-y-4 p-4">
          <p className="text-xs text-muted-foreground">
            作为所有识别的默认提示词；某个 provider 在上方填写覆盖后，该 provider 改用自己的提示词。
          </p>
          <TextAreaField
            label="系统提示词（System）"
            value={draft.defaults.systemPrompt}
            placeholder="描述识别任务、输出约束等"
            onChange={(value) => updateDefaults("systemPrompt", value)}
          />
          <TextAreaField
            label="用户提示词（User）"
            value={draft.defaults.userPrompt}
            placeholder="对单张图片的具体指令"
            onChange={(value) => updateDefaults("userPrompt", value)}
          />
        </div>
      </Panel>
    </div>
  );

  function renderProviderDialog() {
    if (!draft) return null;
    const index = draft.providers.findIndex((provider) => (provider.id ?? provider.providerKey) === editingKey);
    const provider = index >= 0 ? draft.providers[index] : null;
    const cardKey = provider ? provider.id ?? provider.providerKey : "";
    return (
      <Dialog
        open={Boolean(provider)}
        onClose={() => setEditingKey(null)}
        title={provider ? provider.displayName || provider.providerKey : ""}
        description="配置协议、密钥、模型选项与提示词覆盖；改动需点右上角「保存设置」后生效。"
        footer={
          <>
            <Button
              variant="ghost"
              className="mr-auto text-danger hover:text-danger"
              disabled={deleteMutation.isPending}
              onClick={() => provider && deleteProvider(index, provider)}
            >
              <Trash2 size={15} />删除 Provider
            </Button>
            <Button variant="primary" onClick={() => setEditingKey(null)}>完成</Button>
          </>
        }
      >
        {provider ? (
          <div className="space-y-4">
            {deleteMutation.isError ? (
              <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
                删除失败：{deleteMutation.error instanceof Error ? deleteMutation.error.message : String(deleteMutation.error)}
              </div>
            ) : null}
            <div className="grid gap-3 md:grid-cols-2">
              <TextField label="Provider Key" value={provider.providerKey} onChange={(value) => updateProvider(index, { providerKey: value })} />
              <TextField label="显示名称" value={provider.displayName} onChange={(value) => updateProvider(index, { displayName: value })} />
              <label className="block text-sm">
                <span className="mb-1 block text-muted-foreground">协议</span>
                <select
                  className="h-9 w-full rounded-md border border-border bg-background px-3"
                  value={provider.protocol}
                  onChange={(event) => updateProvider(index, defaultProtocolPatch(event.target.value as Protocol))}
                >
                  {protocolOptions.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
              <TextField label="Base URL" value={provider.baseUrl} onChange={(value) => updateProvider(index, { baseUrl: value })} />
              <TextField label="API Key" type="password" value={provider.apiKey ?? ""} placeholder={provider.hasApiKey ? "留空则保留当前密钥" : "输入 API Key"} onChange={(value) => updateProvider(index, { apiKey: value })} />
              <NumberField label="优先级" value={provider.priority} onChange={(value) => updateProvider(index, { priority: value })} />
              <OptionalNumberField label="Temperature" value={provider.temperature} onChange={(value) => updateProvider(index, { temperature: value })} />
              <NumberField label="最大输出 Tokens" value={provider.maxOutputTokens} onChange={(value) => updateProvider(index, { maxOutputTokens: value })} />
            </div>

            <div className="space-y-2 rounded-md border border-border bg-background p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm font-medium">模型选项</div>
                <div className="flex items-center gap-2">
                  {provider.protocol === "openai_responses" ? (
                    <Button size="sm" variant="ghost" onClick={() => importModels(provider)}>
                      <Download size={14} />导入
                    </Button>
                  ) : null}
                  <Button size="sm" variant="secondary" onClick={() => addModel(index)}>
                    <Plus size={14} />新增模型
                  </Button>
                </div>
              </div>
              {importState[cardKey] ? (
                <div className="text-xs text-muted-foreground">{importState[cardKey]}</div>
              ) : null}
              <div className="space-y-2">
                {provider.models.map((model, modelIndex) => (
                  <div key={model.id ?? `${model.modelId}-${modelIndex}`} className="grid gap-2 rounded-md border border-border bg-surface p-2 md:grid-cols-[1.2fr_1fr_88px_96px_auto]">
                    <TextField label="Model ID" value={model.modelId} onChange={(value) => updateModel(index, modelIndex, { modelId: value })} />
                    <TextField label="显示名" value={model.displayName} onChange={(value) => updateModel(index, modelIndex, { displayName: value })} />
                    <NumberField label="优先级" value={model.priority} onChange={(value) => updateModel(index, modelIndex, { priority: value })} />
                    <label className="flex items-end gap-2 pb-2 text-sm text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={model.enabled}
                        onChange={(event) => updateModel(index, modelIndex, { enabled: event.target.checked })}
                      />
                      启用
                    </label>
                    <div className="flex items-end gap-1">
                      <Button size="sm" variant="secondary" aria-label="测试模型连通性" onClick={() => testProviderModel(provider, model)}>
                        <TestTube2 size={14} />测试
                      </Button>
                      {!model.id ? (
                        <Button size="icon" variant="ghost" aria-label="删除未保存模型" onClick={() => removeModel(index, modelIndex)}>
                          <Trash2 size={14} />
                        </Button>
                      ) : null}
                    </div>
                    <div className="md:col-span-5">
                      <span className="text-xs text-muted-foreground">
                        {model.source === "imported" ? "导入" : "手动"}
                        {testState[testKey(provider, model)] ? ` · ${testState[testKey(provider, model)]}` : ""}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <TextAreaField
              label="系统提示词覆盖"
              value={provider.systemPrompt ?? ""}
              placeholder="留空则使用全局默认系统提示词"
              onChange={(value) => updateProvider(index, { systemPrompt: value })}
            />
            <TextAreaField
              label="用户提示词覆盖"
              value={provider.userPrompt ?? ""}
              placeholder="留空则使用全局默认用户提示词"
              onChange={(value) => updateProvider(index, { userPrompt: value })}
            />
          </div>
        ) : null}
      </Dialog>
    );
  }

  function updateDefaults<K extends keyof SettingsPayload["defaults"]>(key: K, value: SettingsPayload["defaults"][K]) {
    setDraft((current) => current ? { ...current, defaults: { ...current.defaults, [key]: value } } : current);
  }

  function updateSelectionDefaults(slot: "primary" | "secondary" | "audit", value: SelectionPatch) {
    setDraft((current) => {
      if (!current) return current;
      return {
        ...current,
        defaults: {
          ...current.defaults,
          [`${slot}ProviderKey`]: value.providerKey,
          [`${slot}ModelId`]: value.modelId,
        },
      };
    });
  }

  function updateProvider(index: number, patch: Partial<ProviderForm>) {
    setDraft((current) => {
      if (!current) return current;
      const providers = current.providers.slice();
      providers[index] = { ...providers[index], ...patch };
      return { ...current, providers };
    });
  }

  function updateModel(providerIndex: number, modelIndex: number, patch: Partial<ProviderModelForm>) {
    setDraft((current) => {
      if (!current) return current;
      const providers = current.providers.slice();
      const provider = providers[providerIndex];
      const models = provider.models.slice();
      models[modelIndex] = { ...models[modelIndex], ...patch };
      providers[providerIndex] = { ...provider, models };
      return { ...current, providers };
    });
  }

  function addProvider() {
    if (!draft) return;
    const newKey = `provider-${draft.providers.length + 1}`;
    setDraft({ ...draft, providers: [...draft.providers, { ...defaultProvider, providerKey: newKey }] });
    setEditingKey(newKey);
  }

  function deleteProvider(index: number, provider: ProviderForm) {
    const label = provider.displayName || provider.providerKey;
    if (!window.confirm(`确认删除 Provider「${label}」及其全部模型？此操作不可恢复。`)) return;
    // 已保存的 provider 走后端删除；未保存（无 id）的只从草稿移除。
    if (provider.id) {
      deleteMutation.mutate(provider.id);
      return;
    }
    setEditingKey(null);
    setDraft((current) => {
      if (!current) return current;
      return { ...current, providers: current.providers.filter((_, i) => i !== index) };
    });
  }

  function addModel(providerIndex: number) {
    setDraft((current) => {
      if (!current) return current;
      const providers = current.providers.slice();
      const provider = providers[providerIndex];
      providers[providerIndex] = {
        ...provider,
        models: [
          ...provider.models,
          {
            modelId: "",
            displayName: "",
            enabled: true,
            priority: 100,
            source: "manual",
            metadataJson: "{}",
          },
        ],
      };
      return { ...current, providers };
    });
  }

  function removeModel(providerIndex: number, modelIndex: number) {
    setDraft((current) => {
      if (!current) return current;
      const providers = current.providers.slice();
      const provider = providers[providerIndex];
      providers[providerIndex] = {
        ...provider,
        models: provider.models.filter((_, index) => index !== modelIndex),
      };
      return { ...current, providers };
    });
  }

  async function testProviderModel(provider: ProviderForm, model: ProviderModelForm) {
    const key = testKey(provider, model);
    if (!provider.id || !model.modelId.trim()) {
      setTestState((current) => ({ ...current, [key]: "请先保存 provider 并填写模型" }));
      return;
    }
    setTestState((current) => ({ ...current, [key]: "测试中（发送 hi）..." }));
    try {
      const result = await apiJson<{ ok: boolean; latencyMs: number; reply?: string }>(
        `/api/settings/providers/${provider.id}/test`,
        {
          method: "POST",
          body: JSON.stringify({ modelId: model.modelId }),
        },
      );
      const reply = result.reply?.trim();
      const preview = reply ? `回复「${reply.length > 60 ? `${reply.slice(0, 60)}…` : reply}」` : "无文本回复";
      setTestState((current) => ({ ...current, [key]: `连接正常 ${result.latencyMs}ms · ${preview}` }));
    } catch (error) {
      setTestState((current) => ({ ...current, [key]: error instanceof Error ? error.message : String(error) }));
    }
  }

  async function importModels(provider: ProviderForm) {
    const key = provider.id ?? provider.providerKey;
    if (!provider.id) {
      setImportState((current) => ({ ...current, [key]: "请先保存后导入" }));
      return;
    }
    setImportState((current) => ({ ...current, [key]: "导入中..." }));
    try {
      const result = await apiJson<{ imported: number; created: number; updated: number; models: ProviderModelForm[] }>(
        `/api/settings/providers/${provider.id}/models/import`,
        { method: "POST", body: "{}" },
      );
      setDraft((current) => {
        if (!current) return current;
        return {
          ...current,
          providers: current.providers.map((item) =>
            item.id === provider.id ? { ...item, models: result.models } : item,
          ),
        };
      });
      setImportState((current) => ({ ...current, [key]: `导入 ${result.imported} 个，新增 ${result.created} 个` }));
    } catch (error) {
      setImportState((current) => ({ ...current, [key]: error instanceof Error ? error.message : String(error) }));
    }
  }
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-muted-foreground">{label}</span>
      <input
        className="h-9 w-full rounded-md border border-border bg-background px-3"
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function TextAreaField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-muted-foreground">{label}</span>
      <textarea
        className="min-h-20 w-full rounded-md border border-border bg-background px-3 py-2 text-sm leading-relaxed"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function ProviderModelSelect({
  label,
  providerKey,
  modelId,
  providers,
  onChange,
}: {
  label: string;
  providerKey: string | null;
  modelId: string | null;
  providers: ProviderForm[];
  onChange: (value: SelectionPatch) => void;
}) {
  const value = providerKey && modelId ? `${providerKey}::${modelId}` : "";
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-muted-foreground">{label}</span>
      <select
        className="h-9 w-full rounded-md border border-border bg-surface px-3"
        value={value}
        onChange={(event) => onChange(parseSelection(event.target.value))}
      >
        <option value="">自动（按优先级）</option>
        {providers.flatMap((provider) =>
          provider.models.map((model) => (
            <option key={`${provider.providerKey}::${model.modelId}`} value={`${provider.providerKey}::${model.modelId}`}>
              {(provider.displayName || provider.providerKey)} · {model.displayName || model.modelId}
              {provider.enabled && model.enabled ? "" : "（未启用）"}
            </option>
          )),
        )}
      </select>
    </label>
  );
}

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- keep an unfocused controlled input synchronized with persisted value
    if (!focused) setDraft(String(value));
  }, [focused, value]);

  return (
    <label className="block text-sm">
      <span className="mb-1 block text-muted-foreground">{label}</span>
      <input
        className="h-9 w-full rounded-md border border-border bg-background px-3"
        type="number"
        value={draft}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          if (draft.trim() === "" || !Number.isFinite(Number(draft))) {
            setDraft(String(value));
          }
        }}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          if (next.trim() === "") return;
          const parsed = Number(next);
          if (Number.isFinite(parsed)) onChange(parsed);
        }}
      />
    </label>
  );
}

function OptionalNumberField({ label, value, onChange }: { label: string; value: number | null; onChange: (value: number | null) => void }) {
  const [draft, setDraft] = useState(value == null ? "" : String(value));
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- keep an unfocused controlled input synchronized with persisted value
    if (!focused) setDraft(value == null ? "" : String(value));
  }, [focused, value]);

  return (
    <label className="block text-sm">
      <span className="mb-1 block text-muted-foreground">{label}</span>
      <input
        className="h-9 w-full rounded-md border border-border bg-background px-3"
        type="number"
        value={draft}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          if (draft.trim() === "") {
            onChange(null);
            return;
          }
          if (!Number.isFinite(Number(draft))) {
            setDraft(value == null ? "" : String(value));
          }
        }}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          if (next.trim() === "") return;
          const parsed = Number(next);
          if (Number.isFinite(parsed)) onChange(parsed);
        }}
      />
    </label>
  );
}

function protocolLabel(protocol: Protocol): string {
  return protocolOptions.find((option) => option.value === protocol)?.label ?? protocol;
}

function defaultProtocolPatch(protocol: Protocol): Partial<ProviderForm> {
  if (protocol === "anthropic_messages") {
    return {
      protocol,
      baseUrl: "https://api.anthropic.com",
      models: [
        {
          modelId: "claude-opus-4-6",
          displayName: "Claude Opus 4.6",
          enabled: true,
          priority: 100,
          source: "manual",
          metadataJson: "{}",
        },
      ],
    };
  }
  return {
    protocol,
    baseUrl: "https://api.openai.com/v1",
    models: [
      {
        modelId: "gpt-4.1",
        displayName: "GPT-4.1",
        enabled: true,
        priority: 100,
        source: "manual",
        metadataJson: "{}",
      },
    ],
  };
}

function parseSelection(value: string): SelectionPatch {
  const [providerKey, ...modelParts] = value.split("::");
  const modelId = modelParts.join("::");
  return providerKey && modelId ? { providerKey, modelId } : { providerKey: null, modelId: null };
}

function testKey(provider: ProviderForm, model: ProviderModelForm) {
  return `${provider.id ?? provider.providerKey}::${model.id ?? model.modelId}`;
}

function normalizeDefaults(defaults: SettingsPayload["defaults"]): SettingsPayload["defaults"] {
  return {
    ...defaults,
    pdfRenderScale: defaults.pdfRenderScale ?? 4,
    primaryModelId: defaults.primaryModelId ?? null,
    secondaryModelId: defaults.secondaryModelId ?? null,
    auditModelId: defaults.auditModelId ?? null,
  };
}
