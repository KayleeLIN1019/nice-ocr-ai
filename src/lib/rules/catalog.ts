import { prisma } from "@/lib/db/client";
import type { DbClient } from "@/lib/db/types";
import {
  RULE_CATALOG_DEFAULTS,
  RULE_CATALOG_DEFAULTS_BY_CODE,
  type RuleCategory,
  type RuleDefinition,
  type RuleSeverity,
} from "@/lib/rules/catalog-defaults";

/** 字典对外形态（DB 行的安全投影 + 默认兜底）。 */
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

/**
 * 惰性补齐：把默认字典里 DB 还没有的 code 写入（已存在的不动，保住运营的覆盖）。
 * 通过 code 唯一约束做 upsert-create-only：用 upsert 但 update 为空对象即「存在则不改」。
 */
export async function ensureRuleCatalogSeeded(db: DbClient = prisma): Promise<void> {
  const existing = await db.ruleCatalog.findMany({ select: { code: true } });
  const known = new Set(existing.map((row) => row.code));
  const missing = RULE_CATALOG_DEFAULTS.filter((rule) => !known.has(rule.code));
  if (!missing.length) return;
  for (const [index, rule] of RULE_CATALOG_DEFAULTS.entries()) {
    if (known.has(rule.code)) continue;
    await db.ruleCatalog.create({
      data: {
        code: rule.code,
        category: rule.category,
        label: rule.label,
        description: rule.description,
        suggestion: rule.suggestion,
        severity: rule.severity,
        sortOrder: index,
        builtin: true,
        enabled: true,
      },
    });
  }
}

/** 读取整本字典（已惰性补齐），按分类分组顺序返回。 */
export async function listRuleCatalog(db: DbClient = prisma): Promise<RuleCatalogEntry[]> {
  await ensureRuleCatalogSeeded(db);
  const rows = await db.ruleCatalog.findMany({
    orderBy: [{ category: "asc" }, { sortOrder: "asc" }, { code: "asc" }],
  });
  return rows.map(toEntry);
}

const PATCHABLE_SEVERITY = new Set<RuleSeverity>(["low", "medium", "high"]);

export interface RuleCatalogPatch {
  label?: string;
  description?: string;
  suggestion?: string;
  severity?: RuleSeverity;
  enabled?: boolean;
}

/** 更新一条规则的可编辑字段。不存在返回 null（路由回 404）。 */
export async function updateRuleCatalog(
  id: string,
  patch: RuleCatalogPatch,
  db: DbClient = prisma,
): Promise<RuleCatalogEntry | null> {
  const existing = await db.ruleCatalog.findUnique({ where: { id } });
  if (!existing) return null;
  const data: Record<string, unknown> = {};
  if (patch.label !== undefined) data.label = patch.label;
  if (patch.description !== undefined) data.description = patch.description;
  if (patch.suggestion !== undefined) data.suggestion = patch.suggestion;
  if (patch.severity !== undefined && PATCHABLE_SEVERITY.has(patch.severity)) data.severity = patch.severity;
  if (patch.enabled !== undefined) data.enabled = patch.enabled;
  const updated = await db.ruleCatalog.update({ where: { id }, data });
  return toEntry(updated);
}

/** 重置为代码默认（仅内置项可重置）。不存在/无默认/非内置返回 null。 */
export async function resetRuleCatalog(id: string, db: DbClient = prisma): Promise<RuleCatalogEntry | null> {
  const existing = await db.ruleCatalog.findUnique({ where: { id } });
  if (!existing) return null;
  const def: RuleDefinition | undefined = RULE_CATALOG_DEFAULTS_BY_CODE[existing.code];
  if (!def) return null;
  const updated = await db.ruleCatalog.update({
    where: { id },
    data: {
      category: def.category,
      label: def.label,
      description: def.description,
      suggestion: def.suggestion,
      severity: def.severity,
      enabled: true,
    },
  });
  return toEntry(updated);
}

function toEntry(row: {
  id: string;
  code: string;
  category: string;
  label: string;
  description: string;
  suggestion: string;
  severity: string;
  enabled: boolean;
  sortOrder: number;
  builtin: boolean;
}): RuleCatalogEntry {
  return {
    id: row.id,
    code: row.code,
    category: (row.category as RuleCategory) ?? "validation",
    label: row.label,
    description: row.description,
    suggestion: row.suggestion,
    severity: (PATCHABLE_SEVERITY.has(row.severity as RuleSeverity) ? row.severity : "medium") as RuleSeverity,
    enabled: row.enabled,
    sortOrder: row.sortOrder,
    builtin: row.builtin,
  };
}
