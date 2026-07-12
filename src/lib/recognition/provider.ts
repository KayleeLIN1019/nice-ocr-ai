import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { AiProviderConfig } from "@prisma/client";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { z } from "zod";
import { decryptSecret } from "@/lib/crypto/secret";
import {
  buildExtractionResultSchema,
  extractionResultSchema,
  normalizeExtraction,
  normalizeExtractionWith,
  type NormalizedExtraction,
} from "@/lib/recognition/schema";
import { DEFAULT_SCENARIO_ID, getScenarioFields } from "@/lib/fields/field-schema";
import {
  defaultRecognitionPrompts,
  getActiveRecognitionTarget,
  sourceRegionPromptInstruction,
  noComputePromptInstruction,
  rowAlignmentInstruction,
  type RecognitionTarget,
  type ProviderProtocol,
} from "@/lib/recognition/settings";

/** 注入式抽取配置：结构化输出 schema + 归一化函数。默认=grocery（与历史行为一致）。 */
export interface ExtractionConfig {
  schema: z.ZodTypeAny;
  normalize: (raw: unknown) => NormalizedExtraction;
}

const defaultExtraction: ExtractionConfig = { schema: extractionResultSchema, normalize: normalizeExtraction };

/** 按场景解析抽取配置：默认场景走 grocery 默认（零变更），其它场景动态生成 schema/normalize。 */
export function extractionConfigForScenario(scenarioId?: string | null): ExtractionConfig {
  if (!scenarioId || scenarioId === DEFAULT_SCENARIO_ID) return defaultExtraction;
  const fields = getScenarioFields(scenarioId);
  return { schema: buildExtractionResultSchema(fields), normalize: (raw) => normalizeExtractionWith(raw, fields) };
}

export interface RecognitionInput {
  imageBase64: string;
  mimeType: string;
}

/** 一次识别使用的提示词（system + user）。 */
export interface ProviderPrompts {
  systemPrompt: string;
  userPrompt: string;
}

/**
 * provider 覆盖优先，其次全局默认，最后 fallback（缺省=内置默认提示词）。空白视为未设置。
 * worker 可传入按场景生成的提示词作为 fallback（grocery 场景生成结果与内置默认等价）。
 */
export function resolveProviderPrompts(
  config: { systemPrompt?: string | null; userPrompt?: string | null },
  defaults?: { systemPrompt?: string | null; userPrompt?: string | null },
  fallback: ProviderPrompts = defaultRecognitionPrompts,
): ProviderPrompts {
  return {
    systemPrompt: config.systemPrompt?.trim() || defaults?.systemPrompt?.trim() || fallback.systemPrompt,
    userPrompt: config.userPrompt?.trim() || defaults?.userPrompt?.trim() || fallback.userPrompt,
  };
}

export type { NormalizedExtraction };

export interface RecognitionProviderResult {
  extraction: NormalizedExtraction;
  providerKey: string;
  protocol: ProviderProtocol;
  model: string;
  tokenUsage?: unknown;
  rawResponse: unknown;
}

export interface RecognitionProvider {
  key: string;
  protocol: ProviderProtocol;
  model: string;
  recognize(input: RecognitionInput): Promise<RecognitionProviderResult>;
}

export async function createConfiguredRecognitionProvider(scenarioId?: string | null) {
  const target = await getActiveRecognitionTarget();
  return createRecognitionProvider(target, resolveProviderPrompts(target.provider), extractionConfigForScenario(scenarioId));
}

/**
 * 强制注入行级区域指令：无论 provider/全局/场景如何自定义系统提示词，都确保模型被要求返回 sourceRegion。
 * 幂等——已包含 sourceRegion 指令（如内置默认）时原样返回，避免重复。
 * 放在 provider 构造处而非 resolveProviderPrompts，是为了保持后者的纯优先级语义（含其单测断言）。
 */
export function ensureSourceRegionInstruction(systemPrompt: string): string {
  return systemPrompt.includes("sourceRegion")
    ? systemPrompt
    : `${systemPrompt}\n${sourceRegionPromptInstruction}`;
}

/**
 * 强制注入「禁止公式计算」指令：无论提示词如何自定义，都要求模型逐字转录单据数字、
 * 不得自行用公式计算金额/单价（否则识别错误会被「算对的金额」掩盖，AMOUNT_MISMATCH 校验也失效）。
 * 幂等——已含该约束（如内置默认）时原样返回。
 */
export function ensureNoComputeInstruction(systemPrompt: string): string {
  return systemPrompt.includes("严禁用")
    ? systemPrompt
    : `${systemPrompt}\n${noComputePromptInstruction}`;
}

/**
 * 强制注入「逐行对齐」指令：缓解识别错行（多行合并/单行拆分/数值串列）。
 * 幂等——已含「逐行转录表格」时原样返回。
 */
export function ensureRowAlignmentInstruction(systemPrompt: string): string {
  return systemPrompt.includes("逐行转录表格")
    ? systemPrompt
    : `${systemPrompt}\n${rowAlignmentInstruction}`;
}

export function createRecognitionProvider(
  target: RecognitionTarget,
  prompts: ProviderPrompts = resolveProviderPrompts(target.provider),
  extraction: ExtractionConfig = defaultExtraction,
): RecognitionProvider {
  // 所有识别 pass（主/副/审核）与 createConfiguredRecognitionProvider 都经此构造，统一在此补回坐标指令。
  const finalPrompts: ProviderPrompts = {
    ...prompts,
    systemPrompt: ensureRowAlignmentInstruction(
      ensureNoComputeInstruction(ensureSourceRegionInstruction(prompts.systemPrompt)),
    ),
  };
  if (target.provider.protocol === "openai_responses") {
    return new OpenAIResponsesProvider(target, finalPrompts, extraction);
  }
  if (target.provider.protocol === "anthropic_messages") {
    return new AnthropicMessagesProvider(target, finalPrompts, extraction);
  }
  throw new Error(`Unsupported AI provider protocol: ${target.provider.protocol}`);
}

class OpenAIResponsesProvider implements RecognitionProvider {
  key: string;
  protocol = "openai_responses" as const;
  model: string;
  private client: OpenAI;
  private config: AiProviderConfig;
  private prompts: ProviderPrompts;
  private extraction: ExtractionConfig;

  constructor(target: RecognitionTarget, prompts: ProviderPrompts, extraction: ExtractionConfig) {
    const config = target.provider;
    assertApiKey(config);
    this.config = config;
    this.prompts = prompts;
    this.extraction = extraction;
    this.key = config.providerKey;
    this.model = target.model.modelId;
    this.client = new OpenAI({
      apiKey: decryptSecret(config.apiKey),
      baseURL: config.baseUrl || undefined,
    });
  }

  async recognize(input: RecognitionInput): Promise<RecognitionProviderResult> {
    const response = await this.client.responses.parse({
      model: this.model,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: this.prompts.systemPrompt },
            { type: "input_text", text: this.prompts.userPrompt },
            {
              type: "input_image",
              image_url: `data:${input.mimeType};base64,${input.imageBase64}`,
              detail: "high",
            },
          ],
        },
      ],
      max_output_tokens: this.config.maxOutputTokens,
      ...(this.config.temperature == null ? {} : { temperature: this.config.temperature }),
      text: {
        format: zodTextFormat(this.extraction.schema, "nice_ocr_extraction"),
      },
    });

    let parsed = response.output_parsed;
    if (!parsed) {
      const text = response.output_text?.trim();
      // 无结构化结果且无可解析文本 → 显式报错，让 job 重试/失败并记录，不静默产出空结果。
      if (!text) {
        throw new Error(`OpenAI 识别未返回结构化结果（provider=${this.key}, model=${this.model}）`);
      }
      parsed = this.extraction.schema.parse(JSON.parse(text));
    }
    return {
      extraction: this.extraction.normalize(parsed),
      providerKey: this.key,
      protocol: this.protocol,
      model: this.model,
      tokenUsage: response.usage,
      rawResponse: response,
    };
  }
}

class AnthropicMessagesProvider implements RecognitionProvider {
  key: string;
  protocol = "anthropic_messages" as const;
  model: string;
  private client: Anthropic;
  private config: AiProviderConfig;
  private prompts: ProviderPrompts;
  private extraction: ExtractionConfig;

  constructor(target: RecognitionTarget, prompts: ProviderPrompts, extraction: ExtractionConfig) {
    const config = target.provider;
    assertApiKey(config);
    this.config = config;
    this.prompts = prompts;
    this.extraction = extraction;
    this.key = config.providerKey;
    this.model = target.model.modelId;
    this.client = new Anthropic({
      apiKey: decryptSecret(config.apiKey),
      baseURL: config.baseUrl || undefined,
    });
  }

  async recognize(input: RecognitionInput): Promise<RecognitionProviderResult> {
    const response = await this.client.messages.parse({
      model: this.model,
      max_tokens: this.config.maxOutputTokens,
      ...(this.config.temperature == null ? {} : { temperature: this.config.temperature }),
      system: this.prompts.systemPrompt,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: toAnthropicMediaType(input.mimeType),
                data: input.imageBase64,
              },
            },
            {
              type: "text",
              text: this.prompts.userPrompt,
            },
          ],
        },
      ],
      output_config: {
        format: zodOutputFormat(this.extraction.schema),
      },
    });
    // 无结构化结果 → 显式报错，不再静默回退空 schema（否则会把空结果当成功落库）。
    const parsed = response.parsed_output;
    if (!parsed) {
      throw new Error(`Anthropic 识别未返回结构化结果（provider=${this.key}, model=${this.model}）`);
    }
    return {
      extraction: this.extraction.normalize(parsed),
      providerKey: this.key,
      protocol: this.protocol,
      model: this.model,
      tokenUsage: response.usage,
      rawResponse: response,
    };
  }
}

function assertApiKey(config: AiProviderConfig) {
  if (!config.apiKey?.trim()) {
    throw new Error(`AI provider ${config.providerKey} is missing apiKey in database settings`);
  }
}

function toAnthropicMediaType(mimeType: string): "image/jpeg" | "image/png" | "image/gif" | "image/webp" {
  if (mimeType === "image/png") return "image/png";
  if (mimeType === "image/gif") return "image/gif";
  if (mimeType === "image/webp") return "image/webp";
  return "image/jpeg";
}
