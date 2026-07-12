import { z } from "zod";
import { normalizeMonth } from "@/lib/validation/rules";
import { isCoreColumn, type FieldDef } from "@/lib/fields/field-schema";
import { normalizeSourceRegion, sourceRegionInputSchema, type SourceRegion } from "@/lib/recognition/source-region";

export const extractionRowSchema = z.object({
  code: z.string().default(""),
  name: z.string().default(""),
  unit: z.string().default(""),
  qty: z.coerce.number().default(0),
  price: z.coerce.number().default(0),
  amount: z.coerce.number().default(0),
  remark: z.string().default(""),
  sourceRegion: sourceRegionInputSchema,
});

export const extractionResultSchema = z.object({
  date: z.string().default(""),
  items: z.array(extractionRowSchema).default([]),
});

export type ExtractionResult = z.infer<typeof extractionResultSchema>;

/** 规范化后的一行：核心识别列 + 非核心字段（extra）。 */
export interface ExtractionRow {
  code: string;
  name: string;
  unit: string;
  qty: number;
  price: number;
  amount: number;
  remark: string;
  /** 该业务行在原图中的归一化来源区域，用于审核台原图高亮。 */
  sourceRegion?: SourceRegion;
  /** 场景声明的非核心字段（core:false），落库进 RecognitionRow.extraJson */
  extra?: Record<string, unknown>;
}

export interface NormalizedExtraction {
  rawDate: string;
  normalizedMonth: string | null;
  rows: ExtractionRow[];
}

/** grocery 默认归一化：保持原行为（rows 即识别 items，无 extra）。 */
export function normalizeExtraction(raw: unknown): NormalizedExtraction {
  const parsed = extractionResultSchema.parse(raw);
  return {
    rawDate: parsed.date,
    normalizedMonth: normalizeMonth(parsed.date),
    rows: parsed.items.map((item) => {
      const { sourceRegion: rawRegion, ...row } = item;
      const sourceRegion = normalizeSourceRegion(rawRegion);
      return {
        ...row,
        ...(sourceRegion ? { sourceRegion } : {}),
      };
    }),
  };
}

const fieldZod = (field: FieldDef) =>
  field.type === "number" ? z.coerce.number().default(0) : z.string().default("");

/** 按场景字段动态生成识别行 schema（替换写死字段，供新场景结构化输出）。 */
export function buildExtractionRowSchema(fields: FieldDef[]) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of fields) shape[field.key] = fieldZod(field);
  shape.sourceRegion = sourceRegionInputSchema;
  return z.object(shape);
}

/** 按场景字段动态生成识别结果 schema（date + items）。 */
export function buildExtractionResultSchema(fields: FieldDef[]) {
  return z.object({
    date: z.string().default(""),
    items: z.array(buildExtractionRowSchema(fields)).default([]),
  });
}

/** 场景感知归一化：把每行拆成核心列（映射 RecognitionRow 真实列）+ extra（存 extraJson）。 */
export function normalizeExtractionWith(raw: unknown, fields: FieldDef[]): NormalizedExtraction {
  const parsed = buildExtractionResultSchema(fields).parse(raw);
  const rows = parsed.items.map((item): ExtractionRow => {
    const record = item as Record<string, unknown>;
    const extra: Record<string, unknown> = {};
    for (const field of fields) {
      if (!isCoreColumn(field.key)) extra[field.key] = record[field.key];
    }
    const sourceRegion = normalizeSourceRegion(record.sourceRegion);
    return {
      code: String(record.code ?? ""),
      name: String(record.name ?? ""),
      unit: String(record.unit ?? ""),
      qty: Number(record.qty ?? 0),
      price: Number(record.price ?? 0),
      amount: Number(record.amount ?? 0),
      remark: String(record.remark ?? ""),
      ...(sourceRegion ? { sourceRegion } : {}),
      ...(Object.keys(extra).length ? { extra } : {}),
    };
  });
  return { rawDate: parsed.date, normalizedMonth: normalizeMonth(parsed.date), rows };
}
