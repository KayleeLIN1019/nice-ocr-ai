/**
 * AuditLog 字段级 diff 工具。
 *
 * 之前把整行 before/after（含 id、createdAt、updatedAt 等噪声）塞进 AuditLog，
 * 既膨胀存储又让“到底改了什么”难以一眼看出。改为只记录**发生变化的字段**的旧/新值。
 */

/** 识别行审计关注的可变字段（排除 id / 时间戳等噪声）。 */
export const AUDITED_ROW_FIELDS: readonly string[] = [
  "code",
  "name",
  "unit",
  "qty",
  "price",
  "amount",
  "remark",
  "extraJson",
  "status",
  "reviewClass",
  "riskLevel",
  "riskReasonsJson",
  "conflictState",
  "auditState",
  "auditNote",
  "deletedAt",
];

/** 产品审计关注的可变字段。 */
export const AUDITED_PRODUCT_FIELDS: readonly string[] = [
  "code",
  "name",
  "unit",
  "aliasesJson",
  "status",
  "remark",
];

export interface FieldDiff {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  changed: string[];
}

/** 比较两个实体在指定字段上的差异，仅返回发生变化的字段（Date 按时间戳比较）。 */
export function diffFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  keys: readonly string[],
): FieldDiff {
  const beforeChanged: Record<string, unknown> = {};
  const afterChanged: Record<string, unknown> = {};
  const changed: string[] = [];
  for (const key of keys) {
    const a = before[key];
    const b = after[key];
    const equal = a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : Object.is(a, b);
    if (!equal) {
      beforeChanged[key] = a;
      afterChanged[key] = b;
      changed.push(key);
    }
  }
  return { before: beforeChanged, after: afterChanged, changed };
}
