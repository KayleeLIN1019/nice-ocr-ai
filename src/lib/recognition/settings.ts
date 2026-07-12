import type { AiProviderConfig, AiProviderModel } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import type { DbClient } from "@/lib/db/types";
import { decryptSecret, encryptSecretForStorage } from "@/lib/crypto/secret";
import { normalizeApprovalMode, type ApprovalMode } from "@/lib/recognition/review";
import { DEFAULT_SCENARIO_ID, type FieldDef, type FieldScenario } from "@/lib/fields/field-schema";

export const supportedProviderProtocols = ["openai_responses", "anthropic_messages"] as const;
export const providerModelSources = ["manual", "imported"] as const;
export const recognitionStrategies = ["fast", "balanced", "consensus", "manual"] as const;
/** 行级原图区域来源：off=不存；model=多模态模型估算（不稳）；layout_ocr=本地 OCR 版面真实坐标。 */
export const sourceRegionModes = ["off", "model", "layout_ocr"] as const;

export type ProviderProtocol = (typeof supportedProviderProtocols)[number];
export type ProviderModelSource = (typeof providerModelSources)[number];
export type RecognitionStrategy = (typeof recognitionStrategies)[number];
export type SourceRegionMode = (typeof sourceRegionModes)[number];

/**
 * 行级原图区域指令：要求模型为每个明细行返回归一化坐标(sourceRegion)，供审核台原图高亮定位。
 * 单独抽成常量，作为「用户可覆盖提示词」之外的强制注入项（见 provider.ensureSourceRegionInstruction）：
 * 一旦用户/历史在设置页保存了不含该指令的自定义提示词，模型就不会返回坐标，原图映射功能会整体失效。
 */
export const sourceRegionPromptInstruction =
  "尽量为每个明细行返回 sourceRegion：该行在整张图片中的归一化位置，x/y/w/h 都是 0..1；无法判断时可省略，不要编造。";

/**
 * 「禁止公式计算」强制指令：要求模型逐字转录单据上印刷/手写的数字，
 * 不得用「数量×单价」等公式自行计算、推算或修正金额与单价。
 * 与 sourceRegionPromptInstruction 一样在 createRecognitionProvider 处幂等强制注入，
 * 避免用户已保存的自定义提示词不含该约束、导致模型重新自行计算金额而掩盖识别错误。
 */
export const noComputePromptInstruction =
  "金额、单价、数量等所有数字必须严格按单据上实际印刷或手写的内容逐字录入；严禁用「数量×单价」等公式自行计算、推算或修正金额与单价。若某个数字看不清或缺失，请如实留空或填 0，交由人工核对，切勿猜测或用公式补齐。";

/**
 * 逐行对齐指令：针对「识别错行」——模型把多行并成一行、一行拆成多行、或数值串到相邻列。
 * 与 noCompute 一样作为强制注入项（见 provider.ensureRowAlignmentInstruction），以稳定子串
 * 「逐行转录表格」做幂等判断。
 */
export const rowAlignmentInstruction =
  "逐行转录表格：单据上每一条印刷或手写的明细行，对应输出且仅输出一行，禁止把多条明细合并成一行、也禁止把一条明细拆成多行；严格保持单据自上而下的原始行顺序。每个数值必须对齐到它所属的列（编码、名称、单位、数量、单价、金额不得错位或串列）；某个单元格为空或看不清时，该字段留空或填 0，绝不要用相邻行或相邻列的值顶替。";

/** 内置默认提示词；provider 未覆盖、全局也未设置时回退到此。 */
export const defaultRecognitionPrompts = {
  systemPrompt:
    "识别图片中的副食品销售单或采购单表格。提取单据日期和明细行。不要输出解释，只按结构化 schema 返回 date 和 items；无法识别的字段用空字符串或 0。" +
    noComputePromptInstruction +
    sourceRegionPromptInstruction,
  userPrompt: "请抽取这张单据图片中的日期和所有表格明细行。",
} as const;

/**
 * 按场景 + 字段生成识别提示词（替换写死副食品文案）。
 * 默认场景（grocery）返回内置默认提示词，保持零行为变更；其它场景按字段标签/提示动态生成。
 */
export function buildRecognitionPrompt(
  scenario: FieldScenario,
  fields: FieldDef[],
): { systemPrompt: string; userPrompt: string } {
  if (scenario.id === DEFAULT_SCENARIO_ID) {
    return { systemPrompt: defaultRecognitionPrompts.systemPrompt, userPrompt: defaultRecognitionPrompts.userPrompt };
  }
  const fieldList = fields
    .map((field) => (field.recognitionHint ? `${field.label}（${field.recognitionHint}）` : field.label))
    .join("、");
  return {
    systemPrompt: `识别图片中的「${scenario.name}」表格。提取单据日期和明细行；每行包含字段：${fieldList}。不要输出解释，只按结构化 schema 返回 date 和 items；无法识别的字段用空字符串或 0。${noComputePromptInstruction}${sourceRegionPromptInstruction}`,
    userPrompt: `请抽取这张「${scenario.name}」图片中的日期和所有表格明细行。`,
  };
}

export interface RecognitionDefaults {
  strategy: RecognitionStrategy;
  approvalMode: ApprovalMode;
  amountTolerance: number;
  queueConcurrency: number;
  maxAttempts: number;
  backoffSeconds: number;
  pdfRenderScale: number;
  /** 双模型交叉验证：pass1 主 provider/model；空则按优先级回退。 */
  primaryProviderKey: string | null;
  primaryModelId: string | null;
  secondaryProviderKey: string | null;
  secondaryModelId: string | null;
  /** 全局默认识别提示词。 */
  systemPrompt: string;
  userPrompt: string;
  /** 审核(二次复查)：抽样比例(0..1，对干净 ai_auto 行额外 AI 复核) 与审核 provider/model。 */
  auditSampleRate: number;
  auditProviderKey: string | null;
  auditModelId: string | null;
  /** 行级原图区域来源策略；layout_ocr 时由 ocrLayoutUrl 指向的本地 OCR 服务出真实坐标。 */
  sourceRegionMode: SourceRegionMode;
  /** 本地 OCR 版面服务地址（如 http://127.0.0.1:8077）；为空则回退 OCR_LAYOUT_URL 环境变量。 */
  ocrLayoutUrl: string | null;
}

export interface SafeAiProviderModel {
  id: string;
  providerId: string;
  modelId: string;
  displayName: string;
  enabled: boolean;
  priority: number;
  source: ProviderModelSource;
  metadataJson: string;
  createdAt: string;
  updatedAt: string;
}

export interface SafeAiProviderConfig {
  id: string;
  providerKey: string;
  displayName: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  enabled: boolean;
  priority: number;
  temperature: number | null;
  maxOutputTokens: number;
  systemPrompt: string | null;
  userPrompt: string | null;
  metadataJson: string;
  hasApiKey: boolean;
  createdAt: string;
  updatedAt: string;
  models: SafeAiProviderModel[];
}

export interface AiProviderModelInput {
  id?: string;
  modelId?: string;
  displayName?: string | null;
  enabled?: boolean;
  priority?: number;
  source?: string;
  metadataJson?: string;
}

export interface AiProviderConfigInput {
  id?: string;
  providerKey?: string;
  displayName?: string;
  protocol?: string;
  baseUrl?: string | null;
  apiKey?: string | null;
  enabled?: boolean;
  priority?: number;
  temperature?: number | null;
  maxOutputTokens?: number;
  systemPrompt?: string | null;
  userPrompt?: string | null;
  metadataJson?: string;
  /** Legacy client compatibility: creates/updates a manual model row. */
  model?: string;
  models?: AiProviderModelInput[];
}

export interface RecognitionSettingsPayload {
  defaults: RecognitionDefaults;
  providers: SafeAiProviderConfig[];
}

export interface RecognitionTarget {
  provider: AiProviderConfig;
  model: AiProviderModel;
}

export interface RecognitionProviderPair {
  primary: RecognitionTarget;
  /** 副模型；未配置或与主相同时退化为 primary（即单模型双跑）。 */
  secondary: RecognitionTarget;
  defaults: RecognitionDefaults;
}

export interface ModelImportResult {
  imported: number;
  created: number;
  updated: number;
  models: SafeAiProviderModel[];
}

export const recognitionDefaults: RecognitionDefaults = {
  strategy: "balanced",
  approvalMode: "hybrid",
  amountTolerance: 0.01,
  queueConcurrency: 3,
  maxAttempts: 3,
  backoffSeconds: 30,
  pdfRenderScale: 4,
  primaryProviderKey: null,
  primaryModelId: null,
  secondaryProviderKey: null,
  secondaryModelId: null,
  systemPrompt: defaultRecognitionPrompts.systemPrompt,
  userPrompt: defaultRecognitionPrompts.userPrompt,
  auditSampleRate: 0.1,
  auditProviderKey: null,
  auditModelId: null,
  sourceRegionMode: "layout_ocr",
  ocrLayoutUrl: null,
};

const recognitionDefaultsKey = "recognition.defaults";
const modelImportTimeoutMs = 10_000;

type ProviderWithModels = AiProviderConfig & { models: AiProviderModel[] };

export function isProviderProtocol(value: string): value is ProviderProtocol {
  return supportedProviderProtocols.includes(value as ProviderProtocol);
}

export function isProviderModelSource(value: string): value is ProviderModelSource {
  return providerModelSources.includes(value as ProviderModelSource);
}

export function normalizeRecognitionStrategy(value: unknown, fallback: RecognitionStrategy = "balanced"): RecognitionStrategy {
  return recognitionStrategies.includes(value as RecognitionStrategy) ? (value as RecognitionStrategy) : fallback;
}

export async function getRecognitionSettings(): Promise<RecognitionSettingsPayload> {
  const [setting, providers] = await Promise.all([
    prisma.appSetting.findUnique({ where: { key: recognitionDefaultsKey } }),
    prisma.aiProviderConfig.findMany({
      orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
      include: { models: { orderBy: [{ priority: "asc" }, { createdAt: "asc" }] } },
    }),
  ]);

  return {
    defaults: parseRecognitionDefaults(setting?.valueJson),
    providers: providers.map(toSafeProviderConfig),
  };
}

export async function getRecognitionDefaults(db: DbClient = prisma): Promise<RecognitionDefaults> {
  const setting = await db.appSetting.findUnique({ where: { key: recognitionDefaultsKey } });
  return parseRecognitionDefaults(setting?.valueJson);
}

export async function updateRecognitionDefaults(input: Partial<RecognitionDefaults>) {
  const current = parseRecognitionDefaults(
    (await prisma.appSetting.findUnique({ where: { key: recognitionDefaultsKey } }))?.valueJson,
  );
  const next = normalizeRecognitionDefaults({ ...current, ...input });
  await prisma.appSetting.upsert({
    where: { key: recognitionDefaultsKey },
    create: { key: recognitionDefaultsKey, valueJson: JSON.stringify(next) },
    update: { valueJson: JSON.stringify(next) },
  });
  return next;
}

export async function upsertAiProviderConfig(input: AiProviderConfigInput) {
  const normalized = normalizeProviderInput(input);
  // 入库前加密：明文 → AES-256-GCM 密文；undefined（未提交）透传以保留原 Key。
  const apiKey = encryptSecretForStorage(normalizeOptionalString(input.apiKey));
  const data = {
    providerKey: normalized.providerKey,
    displayName: normalized.displayName,
    protocol: normalized.protocol,
    baseUrl: normalized.baseUrl,
    enabled: normalized.enabled,
    priority: normalized.priority,
    temperature: normalized.temperature,
    maxOutputTokens: normalized.maxOutputTokens,
    systemPrompt: normalized.systemPrompt,
    userPrompt: normalized.userPrompt,
    metadataJson: normalized.metadataJson,
    ...(apiKey !== undefined ? { apiKey } : {}),
  };

  const provider = input.id
    ? await prisma.aiProviderConfig.update({
        where: { id: input.id },
        data,
      })
    : await prisma.aiProviderConfig.upsert({
        where: { providerKey: normalized.providerKey },
        create: {
          ...data,
          apiKey: apiKey ?? "",
        },
        update: data,
      });

  for (const model of normalized.models) {
    await upsertProviderModel(provider.id, model);
  }

  return toSafeProviderConfig(
    await prisma.aiProviderConfig.findUniqueOrThrow({
      where: { id: provider.id },
      include: { models: { orderBy: [{ priority: "asc" }, { createdAt: "asc" }] } },
    }),
  );
}

export async function deleteAiProviderConfig(providerId: string) {
  const provider = await prisma.aiProviderConfig.findUnique({ where: { id: providerId } });
  if (!provider) {
    throw new Error("Provider not found");
  }
  // 模型对 provider 是 onDelete: Restrict，需在同一事务里先删模型再删 provider。
  await prisma.$transaction([
    prisma.aiProviderModel.deleteMany({ where: { providerId } }),
    prisma.aiProviderConfig.delete({ where: { id: providerId } }),
  ]);
  return { id: providerId, providerKey: provider.providerKey };
}

export async function getActiveRecognitionTarget() {
  const targets = await getEnabledRecognitionTargets();
  const target = targets[0];
  if (!target) {
    throw new Error("No enabled AI provider/model pair with an API key is configured in the database settings");
  }
  return target;
}

/**
 * 解析一个批次实际使用的主/副识别 provider/model（双模型交叉验证）。
 * 优先级：批次显式指定 > 设置页全局默认 > 按优先级回退到已启用 provider/model。
 * 副模型缺省时自动选一个与主模型不同的已启用目标；没有别的可用则退化为主模型双跑。
 */
export async function resolveRecognitionProviders(
  batch: {
    primaryProviderKey?: string | null;
    primaryModelId?: string | null;
    secondaryProviderKey?: string | null;
    secondaryModelId?: string | null;
  } = {},
): Promise<RecognitionProviderPair> {
  const defaults = parseRecognitionDefaults(
    (await prisma.appSetting.findUnique({ where: { key: recognitionDefaultsKey } }))?.valueJson,
  );
  const targets = await getEnabledRecognitionTargets();
  if (targets.length === 0) {
    throw new Error("No enabled AI provider/model pair with an API key is configured in the database settings");
  }

  const primary =
    pickRecognitionTarget(targets, batch.primaryProviderKey, batch.primaryModelId) ??
    pickRecognitionTarget(targets, defaults.primaryProviderKey, defaults.primaryModelId) ??
    targets[0];
  const secondary =
    pickRecognitionTarget(targets, batch.secondaryProviderKey, batch.secondaryModelId) ??
    pickRecognitionTarget(targets, defaults.secondaryProviderKey, defaults.secondaryModelId) ??
    targets.find((target) => target.provider.id !== primary.provider.id || target.model.id !== primary.model.id) ??
    primary;

  return { primary, secondary, defaults };
}

export async function resolveAuditRecognitionTarget(
  primary: RecognitionTarget,
  secondary: RecognitionTarget,
  auditProviderKey: string | null,
  auditModelId: string | null,
) {
  const targets = await getEnabledRecognitionTargets();
  const configured = pickRecognitionTarget(targets, auditProviderKey, auditModelId);
  if (configured) return configured;
  // 默认优先选与主模型不同的目标以获得独立视角。
  return secondary.provider.id !== primary.provider.id || secondary.model.id !== primary.model.id ? secondary : primary;
}

export function toSafeProviderConfig(provider: ProviderWithModels): SafeAiProviderConfig {
  return {
    id: provider.id,
    providerKey: provider.providerKey,
    displayName: provider.displayName,
    protocol: toProtocol(provider.protocol),
    baseUrl: provider.baseUrl ?? "",
    enabled: provider.enabled,
    priority: provider.priority,
    temperature: provider.temperature,
    maxOutputTokens: provider.maxOutputTokens,
    systemPrompt: provider.systemPrompt,
    userPrompt: provider.userPrompt,
    metadataJson: provider.metadataJson,
    hasApiKey: Boolean(provider.apiKey?.trim()),
    createdAt: provider.createdAt.toISOString(),
    updatedAt: provider.updatedAt.toISOString(),
    models: provider.models.map(toSafeProviderModel),
  };
}

export function toSafeProviderModel(model: AiProviderModel): SafeAiProviderModel {
  return {
    id: model.id,
    providerId: model.providerId,
    modelId: model.modelId,
    displayName: model.displayName,
    enabled: model.enabled,
    priority: model.priority,
    source: toProviderModelSource(model.source),
    metadataJson: model.metadataJson,
    createdAt: model.createdAt.toISOString(),
    updatedAt: model.updatedAt.toISOString(),
  };
}

export function deriveOpenAIModelsEndpoint(baseUrl: string | null | undefined) {
  const raw = normalizeOptionalString(baseUrl) ?? defaultBaseUrl("openai_responses");
  const url = new URL(raw);
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/v1") ? `${path}/models` : `${path}/v1/models`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function parseOpenAICompatibleModelsResponse(payload: unknown) {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { data?: unknown }).data)) {
    throw new Error("Unsupported models response shape");
  }
  const seen = new Set<string>();
  const models = [];
  for (const entry of (payload as { data: unknown[] }).data) {
    const modelId =
      typeof entry === "string"
        ? entry.trim()
        : entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string"
          ? (entry as { id: string }).id.trim()
          : "";
    if (!modelId || seen.has(modelId)) continue;
    seen.add(modelId);
    models.push({
      modelId,
      displayName: modelId,
      metadataJson: JSON.stringify(entry && typeof entry === "object" ? entry : { id: modelId }),
    });
  }
  if (!models.length) {
    throw new Error("Models response did not contain model ids");
  }
  return models;
}

export async function importProviderModels(providerId: string, fetcher: typeof fetch = fetch): Promise<ModelImportResult> {
  const provider = await prisma.aiProviderConfig.findUnique({
    where: { id: providerId },
    include: { models: true },
  });
  if (!provider) {
    throw new Error("Provider not found");
  }
  if (provider.protocol !== "openai_responses") {
    throw new Error("Model import is only available for OpenAI-compatible providers");
  }
  if (!provider.apiKey?.trim()) {
    throw new Error("Provider API key is empty");
  }

  const endpoint = deriveOpenAIModelsEndpoint(provider.baseUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), modelImportTimeoutMs);
  let response: Response;
  try {
    response = await fetcher(endpoint, {
      method: "GET",
      headers: { authorization: `Bearer ${decryptSecret(provider.apiKey)}` },
      signal: controller.signal,
    });
  } catch (error) {
    throw new Error(`Model import failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`Model import failed: ${response.status} ${response.statusText}`.trim());
  }

  const models = parseOpenAICompatibleModelsResponse(await response.json());
  let created = 0;
  let updated = 0;
  const existing = new Set(provider.models.map((model) => model.modelId));

  for (const model of models) {
    await prisma.aiProviderModel.upsert({
      where: { providerId_modelId: { providerId, modelId: model.modelId } },
      create: {
        providerId,
        modelId: model.modelId,
        displayName: model.displayName,
        enabled: true,
        priority: nextImportedPriority(provider.models.length + created),
        source: "imported",
        metadataJson: model.metadataJson,
      },
      update: {
        displayName: model.displayName,
        source: "imported",
        metadataJson: model.metadataJson,
      },
    });
    if (existing.has(model.modelId)) updated += 1;
    else created += 1;
  }

  const importedModels = await prisma.aiProviderModel.findMany({
    where: { providerId },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
  });
  return {
    imported: models.length,
    created,
    updated,
    models: importedModels.map(toSafeProviderModel),
  };
}

async function getEnabledRecognitionTargets(): Promise<RecognitionTarget[]> {
  const providers = await prisma.aiProviderConfig.findMany({
    where: {
      enabled: true,
      AND: [{ apiKey: { not: null } }, { apiKey: { not: "" } }],
    },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    include: {
      models: {
        where: { enabled: true },
        orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
      },
    },
  });

  return providers.flatMap((provider) => provider.models.map((model) => ({ provider, model })));
}

function pickRecognitionTarget(
  targets: RecognitionTarget[],
  providerKey?: string | null,
  modelId?: string | null,
) {
  const normalizedProviderKey = normalizePromptString(providerKey);
  const normalizedModelId = normalizePromptString(modelId);
  if (!normalizedProviderKey) return null;
  if (normalizedModelId) {
    const exact = targets.find(
      (target) => target.provider.providerKey === normalizedProviderKey && target.model.modelId === normalizedModelId,
    );
    if (exact) return exact;
  }
  return targets.find((target) => target.provider.providerKey === normalizedProviderKey) ?? null;
}

async function upsertProviderModel(providerId: string, input: NormalizedProviderModelInput) {
  if (input.id) {
    const existing = await prisma.aiProviderModel.findFirst({
      where: { id: input.id, providerId },
      select: { id: true },
    });
    if (!existing) {
      throw new Error("Provider model does not belong to this provider");
    }
    return prisma.aiProviderModel.update({
      where: { id: input.id },
      data: {
        modelId: input.modelId,
        displayName: input.displayName,
        enabled: input.enabled,
        priority: input.priority,
        source: input.source,
        metadataJson: input.metadataJson,
      },
    });
  }
  return prisma.aiProviderModel.upsert({
    where: { providerId_modelId: { providerId, modelId: input.modelId } },
    create: {
      providerId,
      modelId: input.modelId,
      displayName: input.displayName,
      enabled: input.enabled,
      priority: input.priority,
      source: input.source,
      metadataJson: input.metadataJson,
    },
    update: {
      displayName: input.displayName,
      enabled: input.enabled,
      priority: input.priority,
      source: input.source,
      metadataJson: input.metadataJson,
    },
  });
}

interface NormalizedProviderModelInput {
  id?: string;
  modelId: string;
  displayName: string;
  enabled: boolean;
  priority: number;
  source: ProviderModelSource;
  metadataJson: string;
}

function normalizeProviderInput(input: AiProviderConfigInput) {
  const providerKey = normalizeRequiredString(input.providerKey, "providerKey");
  const displayName = normalizeRequiredString(input.displayName, "displayName");
  const protocol = toProtocol(normalizeRequiredString(input.protocol, "protocol"));
  const explicitModels = Array.isArray(input.models) ? input.models : [];
  const legacyModel = normalizeOptionalString(input.model);
  const models = explicitModels.map(normalizeProviderModelInput);
  if (legacyModel && !models.some((model) => model.modelId === legacyModel)) {
    models.push(
      normalizeProviderModelInput({
        modelId: legacyModel,
        displayName: legacyModel,
        enabled: true,
        priority: 100,
        source: "manual",
      }),
    );
  }
  return {
    providerKey,
    displayName,
    protocol,
    baseUrl: normalizeOptionalString(input.baseUrl) ?? defaultBaseUrl(protocol),
    enabled: Boolean(input.enabled),
    priority: clampInt(input.priority, 1, 999, 100),
    temperature: clampOptionalNumber(input.temperature, 0, 2),
    maxOutputTokens: clampInt(input.maxOutputTokens, 256, 16000, 2000),
    systemPrompt: normalizePromptString(input.systemPrompt),
    userPrompt: normalizePromptString(input.userPrompt),
    metadataJson: normalizeJsonObjectString(input.metadataJson),
    models,
  };
}

function normalizeProviderModelInput(input: AiProviderModelInput): NormalizedProviderModelInput {
  return {
    id: normalizeOptionalString(input.id),
    modelId: normalizeRequiredString(input.modelId, "modelId"),
    displayName: normalizeOptionalString(input.displayName) ?? "",
    enabled: input.enabled !== false,
    priority: clampInt(input.priority, 1, 999, 100),
    source: toProviderModelSource(normalizeOptionalString(input.source) ?? "manual"),
    metadataJson: normalizeJsonObjectString(input.metadataJson),
  };
}

/** 提示词覆盖：空字符串视为“未覆盖”→ null（识别时回退全局默认）。 */
function normalizePromptString(value: unknown): string | null {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
}

export function parseRecognitionDefaults(raw?: string | null): RecognitionDefaults {
  if (!raw) return recognitionDefaults;
  try {
    return normalizeRecognitionDefaults(JSON.parse(raw) as Partial<RecognitionDefaults>);
  } catch {
    return recognitionDefaults;
  }
}

function normalizeRecognitionDefaults(input: Partial<RecognitionDefaults>): RecognitionDefaults {
  const strategy = normalizeRecognitionStrategy(input.strategy, recognitionDefaults.strategy);
  return {
    strategy,
    approvalMode: normalizeApprovalMode(input.approvalMode),
    amountTolerance: clampNumber(input.amountTolerance, 0, 100, recognitionDefaults.amountTolerance),
    queueConcurrency: clampInt(input.queueConcurrency, 1, 12, recognitionDefaults.queueConcurrency),
    maxAttempts: clampInt(input.maxAttempts, 1, 10, recognitionDefaults.maxAttempts),
    backoffSeconds: clampInt(input.backoffSeconds, 1, 3600, recognitionDefaults.backoffSeconds),
    pdfRenderScale: clampNumber(input.pdfRenderScale, 1, 6, recognitionDefaults.pdfRenderScale),
    primaryProviderKey: normalizePromptString(input.primaryProviderKey),
    primaryModelId: normalizePromptString(input.primaryModelId),
    secondaryProviderKey: normalizePromptString(input.secondaryProviderKey),
    secondaryModelId: normalizePromptString(input.secondaryModelId),
    systemPrompt: normalizeOptionalString(input.systemPrompt) ?? recognitionDefaults.systemPrompt,
    userPrompt: normalizeOptionalString(input.userPrompt) ?? recognitionDefaults.userPrompt,
    auditSampleRate: clampNumber(input.auditSampleRate, 0, 1, recognitionDefaults.auditSampleRate),
    auditProviderKey: normalizePromptString(input.auditProviderKey),
    auditModelId: normalizePromptString(input.auditModelId),
    sourceRegionMode: sourceRegionModes.includes(input.sourceRegionMode as SourceRegionMode)
      ? (input.sourceRegionMode as SourceRegionMode)
      : recognitionDefaults.sourceRegionMode,
    ocrLayoutUrl: normalizePromptString(input.ocrLayoutUrl),
  };
}

function toProtocol(value: string): ProviderProtocol {
  if (!isProviderProtocol(value)) {
    throw new Error(`Unsupported AI provider protocol: ${value}`);
  }
  return value;
}

function toProviderModelSource(value: string): ProviderModelSource {
  if (!isProviderModelSource(value)) {
    throw new Error(`Unsupported provider model source: ${value}`);
  }
  return value;
}

function defaultBaseUrl(protocol: ProviderProtocol) {
  return protocol === "anthropic_messages" ? "https://api.anthropic.com" : "https://api.openai.com/v1";
}

function normalizeRequiredString(value: unknown, field: string) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new Error(`${field} is required`);
  }
  return normalized;
}

function normalizeOptionalString(value: unknown) {
  if (value == null) return undefined;
  const normalized = String(value).trim();
  return normalized ? normalized : undefined;
}

function normalizeJsonObjectString(value: unknown) {
  if (value == null || String(value).trim() === "") return "{}";
  const parsed = JSON.parse(String(value));
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("metadataJson must be a JSON object");
  }
  return JSON.stringify(parsed);
}

function nextImportedPriority(offset: number) {
  return clampInt(100 + offset, 1, 999, 100);
}

function clampInt(value: unknown, min: number, max: number, fallback: number) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function clampNumber(value: unknown, min: number, max: number, fallback: number) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function clampOptionalNumber(value: unknown, min: number, max: number): number | null {
  if (value == null || String(value).trim() === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(max, Math.max(min, number));
}
