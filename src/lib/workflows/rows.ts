import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import type { DbClient } from "@/lib/db/types";
import { AUDITED_ROW_FIELDS, diffFields } from "@/lib/audit-log";
import { isShortProductCode, validateRow } from "@/lib/validation/rules";

export type ConfirmSelector = {
  rowIds?: string[];
  documentId?: string;
  batchId?: string;
  onlyLowRisk?: boolean;
};

/**
 * 批量确认识别行。按优先级解析选择器：rowIds[] > documentId > batchId。
 * 三者都缺失时返回 null（调用方应回 400），避免空选择误确认全部数据。
 * batchId / documentId 默认仅确认低风险行（onlyLowRisk）；rowIds 精确确认所选行。
 */
export async function confirmRecognitionRows(selector: ConfirmSelector, db: DbClient = prisma) {
  let where: Prisma.RecognitionRowWhereInput;
  if (selector.rowIds && selector.rowIds.length > 0) {
    where = { deletedAt: null, id: { in: selector.rowIds.map(String) } };
  } else if (selector.documentId) {
    where = {
      deletedAt: null,
      documentId: String(selector.documentId),
      ...(selector.onlyLowRisk ? { riskLevel: "low" } : {}),
    };
  } else if (selector.batchId) {
    where = {
      deletedAt: null,
      batchId: String(selector.batchId),
      ...(selector.onlyLowRisk !== false ? { riskLevel: "low" } : {}),
    };
  } else {
    return null;
  }

  const result = await db.recognitionRow.updateMany({
    where,
    data: { status: "confirmed", reviewClass: "human" },
  });
  // 人工确认即视为已复审：把这批中仍为 flagged 的行置 reviewed，使其离开复审队列。
  await db.recognitionRow.updateMany({
    where: { ...where, auditState: "flagged" },
    data: { auditState: "reviewed" },
  });

  // 处理计时（task 1）：确认收口后，对受影响单据中「已无待确认行且已记起点」者写入完成时间。
  let affectedDocIds: string[] = [];
  if (selector.documentId) {
    affectedDocIds = [String(selector.documentId)];
  } else if (selector.rowIds && selector.rowIds.length > 0) {
    const docs = await db.recognitionRow.findMany({
      where: { id: { in: selector.rowIds.map(String) } },
      select: { documentId: true },
      distinct: ["documentId"],
    });
    affectedDocIds = docs.map((doc) => doc.documentId);
  } else if (selector.batchId) {
    const docs = await db.document.findMany({
      where: { batchId: String(selector.batchId) },
      select: { id: true },
    });
    affectedDocIds = docs.map((doc) => doc.id);
  }
  await stampReviewCompletion(affectedDocIds, db);

  return result.count;
}

/** 对已无待确认行（且已记起点、尚未记完成）的文档写入 reviewCompletedAt（task 1 处理计时终点）。 */
async function stampReviewCompletion(documentIds: string[], db: DbClient) {
  for (const documentId of documentIds) {
    const pending = await db.recognitionRow.count({
      where: { documentId, deletedAt: null, status: { not: "confirmed" } },
    });
    if (pending > 0) continue;
    const total = await db.recognitionRow.count({ where: { documentId, deletedAt: null } });
    if (total === 0) continue; // 无行的文档不计入计时
    const doc = await db.document.findUnique({
      where: { id: documentId },
      select: { reviewStartedAt: true, reviewCompletedAt: true },
    });
    if (doc?.reviewStartedAt && !doc.reviewCompletedAt) {
      await db.document.update({ where: { id: documentId }, data: { reviewCompletedAt: new Date() } });
    }
  }
}

export type RowUpdateInput = {
  code?: string | null;
  name?: string;
  unit?: string | null;
  qty?: number;
  price?: number;
  amount?: number;
  remark?: string | null;
  /** 场景声明的非核心字段，合并进 extraJson（不覆盖未提交的键）。 */
  extra?: Record<string, unknown>;
};

export type ClearShortCodeSelector = {
  rowIds?: string[];
  documentId?: string;
};

export type ReplaceProductCodeSelector = {
  name: string;
  toCode: string;
  rowIds?: string[];
  batchId?: string;
  status?: string;
  risk?: string;
  auditState?: string;
};

export type ReplaceProductNameSelector = {
  code: string;
  toName: string;
  rowIds?: string[];
  batchId?: string;
  status?: string;
  risk?: string;
  auditState?: string;
};

/** 合并 extra patch 到既有 extraJson，返回新的 JSON 字符串；无 patch 时返回 undefined（不更新该列）。 */
function mergeExtraJson(currentJson: string, patch?: Record<string, unknown>): string | undefined {
  if (!patch || Object.keys(patch).length === 0) return undefined;
  let current: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(currentJson || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      current = parsed as Record<string, unknown>;
  } catch {
    current = {};
  }
  return JSON.stringify({ ...current, ...patch });
}

export async function updateRecognitionRow(id: string, input: RowUpdateInput, db: DbClient = prisma) {
  const before = await db.recognitionRow.findUnique({ where: { id } });
  if (!before) return null;

  const next = {
    code: input.code ?? before.code ?? "",
    name: input.name ?? before.name,
    qty: input.qty ?? before.qty,
    price: input.price ?? before.price,
    amount: input.amount ?? before.amount,
  };
  const validation = validateRow(next);

  const row = await db.recognitionRow.update({
    where: { id },
    data: {
      code: input.code ?? undefined,
      name: input.name ?? undefined,
      unit: input.unit ?? undefined,
      qty: input.qty === undefined ? undefined : Number(input.qty),
      price: input.price === undefined ? undefined : Number(input.price),
      amount: input.amount === undefined ? undefined : Number(input.amount),
      remark: input.remark ?? undefined,
      extraJson: mergeExtraJson(before.extraJson, input.extra),
      riskLevel: validation.riskLevel,
      riskReasonsJson: JSON.stringify(validation.reasons),
      // 人工编辑待复审行即视为已复审。
      ...(before.auditState === "flagged" ? { auditState: "reviewed" } : {}),
    },
  });

  const diff = diffFields(before, row, AUDITED_ROW_FIELDS);
  await db.auditLog.create({
    data: {
      entityType: "RecognitionRow",
      entityId: id,
      action: "update",
      // 仅记录发生变化的字段的旧/新值（字段级 diff），避免整行噪声膨胀。
      beforeJson: JSON.stringify(diff.before),
      afterJson: JSON.stringify(diff.after),
    },
  });

  return row;
}

/**
 * 清空短商品编码（少于 3 位）。按优先级解析选择器：rowIds[] > documentId。
 * 只会修改命中短编码规则的非删除行，避免误清正常编码；每行沿用 updateRecognitionRow 留审计。
 */
export async function clearShortProductCodes(selector: ClearShortCodeSelector, db: DbClient = prisma) {
  let where: Prisma.RecognitionRowWhereInput;
  if (selector.rowIds && selector.rowIds.length > 0) {
    where = { deletedAt: null, id: { in: selector.rowIds.map(String) } };
  } else if (selector.documentId) {
    where = { deletedAt: null, documentId: String(selector.documentId) };
  } else {
    return null;
  }

  const candidates = await db.recognitionRow.findMany({
    where,
    select: { id: true, code: true },
  });
  const matched = candidates.filter((row) => isShortProductCode(row.code));

  for (const row of matched) {
    await updateRecognitionRow(row.id, { code: "" }, db);
  }

  return { matched: matched.length, updated: matched.length };
}

/**
 * 批量统一同名商品编码。作用域为「同一商品名 + 当前筛选条件（批次/状态/风险/审核）」，
 * 不受分页限制；每一行沿用 updateRecognitionRow，保证风险重算与审计日志一致。
 */
export async function replaceProductCodesByName(selector: ReplaceProductCodeSelector, db: DbClient = prisma) {
  const name = selector.name.trim();
  const toCode = selector.toCode.trim();
  if (!name || !toCode) return null;

  const where: Prisma.RecognitionRowWhereInput = {
    deletedAt: null,
    name,
    ...(selector.rowIds && selector.rowIds.length > 0 ? { id: { in: selector.rowIds.map(String) } } : {}),
    ...(selector.batchId ? { batchId: selector.batchId } : {}),
    ...(selector.status ? { status: selector.status } : {}),
    ...(selector.risk ? { riskLevel: selector.risk } : {}),
    ...(selector.auditState ? { auditState: selector.auditState } : {}),
  };

  const candidates = await db.recognitionRow.findMany({
    where,
    select: { id: true, code: true },
  });

  const codeCounts = new Map<string, number>();
  for (const row of candidates) {
    const code = row.code?.trim() || "";
    codeCounts.set(code, (codeCounts.get(code) ?? 0) + 1);
  }

  let updated = 0;
  for (const row of candidates) {
    if ((row.code?.trim() || "") === toCode) continue;
    await updateRecognitionRow(row.id, { code: toCode }, db);
    updated += 1;
  }

  return {
    matched: candidates.length,
    updated,
    codesBefore: [...codeCounts.entries()].map(([code, count]) => ({ code, count })),
  };
}

/**
 * 批量统一同编码商品名称。作用域为「同一商品编码 + 当前筛选条件/冲突来源行」，
 * 供处理「同编码不同产品」时一键把少数派 OCR 名称替换为目标商品名。
 */
export async function replaceProductNamesByCode(selector: ReplaceProductNameSelector, db: DbClient = prisma) {
  const code = selector.code.trim();
  const toName = selector.toName.trim();
  if (!code || !toName) return null;

  const where: Prisma.RecognitionRowWhereInput = {
    deletedAt: null,
    code,
    ...(selector.rowIds && selector.rowIds.length > 0 ? { id: { in: selector.rowIds.map(String) } } : {}),
    ...(selector.batchId ? { batchId: selector.batchId } : {}),
    ...(selector.status ? { status: selector.status } : {}),
    ...(selector.risk ? { riskLevel: selector.risk } : {}),
    ...(selector.auditState ? { auditState: selector.auditState } : {}),
  };

  const candidates = await db.recognitionRow.findMany({
    where,
    select: { id: true, name: true },
  });

  const nameCounts = new Map<string, number>();
  for (const row of candidates) {
    const name = row.name.trim();
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }

  let updated = 0;
  for (const row of candidates) {
    if (row.name.trim() === toName) continue;
    await updateRecognitionRow(row.id, { name: toName }, db);
    updated += 1;
  }

  return {
    matched: candidates.length,
    updated,
    namesBefore: [...nameCounts.entries()].map(([name, count]) => ({ name, count })),
  };
}

/**
 * 软删除（排除）识别行：置 deletedAt + status=excluded，并留痕审计日志。
 * 删除是不可逆操作，与 updateRecognitionRow 一样写 AuditLog 以便追溯。
 * 行不存在（或已删除）时返回 null，调用方应回 404。
 */
export async function excludeRecognitionRow(id: string, db: DbClient = prisma) {
  const before = await db.recognitionRow.findUnique({ where: { id } });
  if (!before || before.deletedAt) return null;

  const row = await db.recognitionRow.update({
    where: { id },
    data: { deletedAt: new Date(), status: "excluded" },
  });

  const diff = diffFields(before, row, AUDITED_ROW_FIELDS);
  await db.auditLog.create({
    data: {
      entityType: "RecognitionRow",
      entityId: id,
      action: "exclude",
      beforeJson: JSON.stringify(diff.before),
      afterJson: JSON.stringify(diff.after),
    },
  });

  return row;
}

export type RowCreateInput = {
  /** 所属文档；新行从该文档继承 batchId。 */
  documentId: string;
  /** 在此行下方插入；缺省则追加到文档末尾。 */
  afterRowId?: string | null;
  code?: string | null;
  name?: string;
  unit?: string | null;
  qty?: number;
  price?: number;
  amount?: number;
  remark?: string | null;
  /** 场景声明的非核心字段，写入 extraJson。 */
  extra?: Record<string, unknown>;
};

/**
 * 人工新建一条识别行（审核台「新增行」）。
 * - documentId 必填，从所属文档继承 batchId；文档不存在返回 null（调用方回 404）。
 * - afterRowId 指定且有效时在该行下方插入：新行 rowIndex = 目标行+1，并把其后行整体下移，
 *   保持 rowIndex 顺序连续（文档详情按 rowIndex 升序展示）；否则追加到末尾（max+1）。
 * - 跑 validateRow 计算 riskLevel/reasons；reviewClass=human、status=pending；写 AuditLog(action=create)。
 */
export async function createRecognitionRow(input: RowCreateInput, db: DbClient = prisma) {
  const document = await db.document.findUnique({ where: { id: input.documentId } });
  if (!document) return null;

  const after = input.afterRowId
    ? await db.recognitionRow.findUnique({ where: { id: input.afterRowId } })
    : null;

  let rowIndex: number;
  if (after && after.documentId === input.documentId && !after.deletedAt) {
    rowIndex = after.rowIndex + 1;
    // 其后行整体下移，给新行让出位置。
    await db.recognitionRow.updateMany({
      where: { documentId: input.documentId, deletedAt: null, rowIndex: { gte: rowIndex } },
      data: { rowIndex: { increment: 1 } },
    });
  } else {
    const max = await db.recognitionRow.aggregate({
      where: { documentId: input.documentId, deletedAt: null },
      _max: { rowIndex: true },
    });
    rowIndex = (max._max.rowIndex ?? 0) + 1;
  }

  const validation = validateRow({
    code: input.code ?? "",
    name: input.name ?? "",
    qty: Number(input.qty ?? 0),
    price: Number(input.price ?? 0),
    amount: Number(input.amount ?? 0),
  });

  const row = await db.recognitionRow.create({
    data: {
      batchId: document.batchId,
      documentId: input.documentId,
      rowIndex,
      code: input.code ?? null,
      name: input.name ?? "",
      unit: input.unit ?? null,
      qty: Number(input.qty ?? 0),
      price: Number(input.price ?? 0),
      amount: Number(input.amount ?? 0),
      remark: input.remark ?? null,
      extraJson: input.extra && Object.keys(input.extra).length ? JSON.stringify(input.extra) : "{}",
      status: "pending",
      reviewClass: "human",
      riskLevel: validation.riskLevel,
      riskReasonsJson: JSON.stringify(validation.reasons),
    },
  });

  await db.auditLog.create({
    data: {
      entityType: "RecognitionRow",
      entityId: row.id,
      action: "create",
      beforeJson: null,
      afterJson: JSON.stringify(row),
    },
  });

  return row;
}
