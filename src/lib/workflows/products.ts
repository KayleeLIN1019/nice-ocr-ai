import { prisma } from "@/lib/db/client";
import type { DbClient } from "@/lib/db/types";
import { cleanProductCode, isInvalidProductName } from "@/lib/validation/rules";
import { normalizedConflictCode } from "@/lib/products/conflicts";

/** 产品键：有规范编码按编码+名称，否则按名称（与识别一致性比对/审计统计一致）。 */
function productKey(code: string | null | undefined, name: string): string {
  const clean = cleanProductCode(code);
  return clean ? `code:${clean}|name:${name}` : `name:${name}`;
}

/** 正数样本的中位数；无样本返回 null。 */
function median(values: number[]): number | null {
  const nums = values.filter((value) => value > 0).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

/** 出现最多的非空取值；全空返回 null。 */
function dominant(values: Array<string | null | undefined>): string | null {
  const counts = new Map<string, number>();
  for (const value of values) {
    const text = value?.trim();
    if (text) counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

type PreservedConflictResolution = {
  status: string;
  resolutionNote: string | null;
  resolvedAt: Date | null;
};

function conflictResolutionKey({
  type,
  productName,
  productCode,
  reason,
}: {
  type: string;
  productName?: string | null;
  productCode?: string | null;
  reason: string;
}) {
  return [type, productName ?? "", productCode ?? "", reason].join("\u001f");
}

async function loadPreservedConflictResolutions(db: DbClient) {
  const conflicts = await db.productConflict.findMany({
    where: { status: { in: ["resolved", "ignored"] } },
    include: { product: { select: { name: true, code: true } } },
  });

  const map = new Map<string, PreservedConflictResolution>();
  for (const conflict of conflicts) {
    map.set(
      conflictResolutionKey({
        type: conflict.type,
        productName: conflict.product?.name,
        productCode: conflict.product?.code,
        reason: conflict.reason,
      }),
      {
        status: conflict.status,
        resolutionNote: conflict.resolutionNote,
        resolvedAt: conflict.resolvedAt,
      },
    );
  }
  return map;
}

function preservedConflictFields(
  preserved: Map<string, PreservedConflictResolution>,
  input: { type: string; productName?: string | null; productCode?: string | null; reason: string },
) {
  const resolution = preserved.get(conflictResolutionKey(input));
  return resolution
    ? {
        status: resolution.status,
        resolutionNote: resolution.resolutionNote,
        resolvedAt: resolution.resolvedAt,
      }
    : {};
}

/**
 * 重建产品库：从已确认行（可选含待确认）沉淀产品观测，再聚合成产品主数据。
 * 每个产品记录名称、**主导单位**（同名多单位取最常见）与**代表单价**（历史成交单价中位数，
 * 取自已确认行 + 导入历史 ProductPriceHistory）。为审核台「按产品名联想单位」与单价/单位校验提供基线。
 */
export async function rebuildProductLibrary(options: { includePending?: boolean } = {}, db: DbClient = prisma) {
  const [rows, priceHistory] = await Promise.all([
    db.recognitionRow.findMany({
      where: {
        deletedAt: null,
        ...(options.includePending ? {} : { status: "confirmed" }),
      },
    }),
    db.productPriceHistory.findMany({ select: { code: true, name: true, price: true } }),
  ]);
  const preservedConflictResolutions = await loadPreservedConflictResolutions(db);

  await db.productObservation.deleteMany({});
  await db.productConflict.deleteMany({});
  await db.product.deleteMany({});

  for (const row of rows) {
    await db.productObservation.create({
      data: {
        rowId: row.id,
        batchId: row.batchId,
        documentId: row.documentId,
        rawCode: row.code,
        cleanCode: cleanProductCode(row.code),
        name: row.name,
        unit: row.unit,
        qty: row.qty,
        normalizedMonth: row.normalizedMonth,
      },
    });
  }

  // 单价样本：已确认行 + 导入历史，按产品键聚合，用于取中位数代表单价。
  const priceByKey = new Map<string, number[]>();
  const addPrice = (code: string | null | undefined, name: string, price: number) => {
    if (!(price > 0)) return;
    const key = productKey(code, name);
    priceByKey.set(key, [...(priceByKey.get(key) ?? []), price]);
  };
  for (const row of rows) addPrice(row.code, row.name, row.price);
  for (const history of priceHistory) addPrice(history.code, history.name, history.price);

  const observations = await db.productObservation.findMany();
  const productKeys = new Map<string, typeof observations>();
  const rowsByName = new Map<string, typeof observations>();
  const codesByName = new Map<string, Set<string>>();
  const rowsByCode = new Map<string, typeof observations>();
  const namesByCode = new Map<string, Set<string>>();
  for (const observation of observations) {
    const key = observation.cleanCode ? `code:${observation.cleanCode}|name:${observation.name}` : `name:${observation.name}`;
    productKeys.set(key, [...(productKeys.get(key) ?? []), observation]);
    rowsByName.set(observation.name, [...(rowsByName.get(observation.name) ?? []), observation]);
    const code = normalizedConflictCode(observation.cleanCode);
    if (code) {
      const codes = codesByName.get(observation.name) ?? new Set<string>();
      codes.add(code);
      codesByName.set(observation.name, codes);
      rowsByCode.set(code, [...(rowsByCode.get(code) ?? []), observation]);
      const names = namesByCode.get(code) ?? new Set<string>();
      names.add(observation.name);
      namesByCode.set(code, names);
    }
  }

  let conflictCount = 0;
  for (const [key, list] of productKeys) {
    const first = list[0];
    const product = await db.product.create({
      data: {
        code: first.cleanCode,
        name: first.name,
        unit: dominant(list.map((item) => item.unit)) ?? first.unit,
        price: median(priceByKey.get(key) ?? []),
        firstSeenAt: first.createdAt,
        lastSeenAt: list[list.length - 1].createdAt,
      },
    });

    if (isInvalidProductName(first.name)) {
      conflictCount += 1;
      const type = "INVALID_PRODUCT_NAME";
      const reason = "疑似非商品名";
      await db.productConflict.create({
        data: {
          productId: product.id,
          type,
          severity: "high",
          reason,
          sourceRowIdsJson: JSON.stringify(list.map((item) => item.rowId)),
          ...preservedConflictFields(preservedConflictResolutions, {
            type,
            productName: product.name,
            productCode: product.code,
            reason,
          }),
        },
      });
    }

    const codes = [...(codesByName.get(first.name) ?? [])].sort();
    if (codes.length > 1) {
      conflictCount += 1;
      const type = "NAME_MULTI_CODE";
      const reason = `同一商品名对应多个编码：${codes.join("、")}`;
      await db.productConflict.create({
        data: {
          productId: product.id,
          type,
          severity: "medium",
          reason,
          sourceRowIdsJson: JSON.stringify((rowsByName.get(first.name) ?? list).map((item) => item.rowId)),
          ...preservedConflictFields(preservedConflictResolutions, {
            type,
            productName: product.name,
            productCode: product.code,
            reason,
          }),
        },
      });
    }

    const conflictCode = normalizedConflictCode(first.cleanCode);
    const names = conflictCode ? [...(namesByCode.get(conflictCode) ?? [])].sort() : [];
    if (names.length > 1) {
      conflictCount += 1;
      const type = "CODE_NAME_CONFLICT";
      const reason = `同一编码对应多个商品：${names.join("、")}`;
      await db.productConflict.create({
        data: {
          productId: product.id,
          type,
          severity: "high",
          reason,
          sourceRowIdsJson: JSON.stringify((rowsByCode.get(conflictCode) ?? list).map((item) => item.rowId)),
          ...preservedConflictFields(preservedConflictResolutions, {
            type,
            productName: product.name,
            productCode: product.code,
            reason,
          }),
        },
      });
    }
  }

  return { products: productKeys.size, conflicts: conflictCount };
}

let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
let rebuildRunning = false;

/**
 * 防抖触发产品库重建（fire-and-forget）：连续确认时只重置计时器，停止确认 delayMs 后才真正重建一次。
 * 全量重建会删光产品/观测再从所有确认行重建（几千条写入），SQLite 单写锁——若每次确认都触发，
 * 重建一直占锁会拖慢紧接着的确认/编辑请求。防抖把重建挪到"你停下来时"跑一次，确认本身不再受影响。
 */
export function scheduleProductLibraryRebuild(delayMs = 30_000) {
  if (rebuildTimer) clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null;
    if (rebuildRunning) {
      scheduleProductLibraryRebuild(5_000); // 正在重建则稍后再排，避免并发全量重建
      return;
    }
    rebuildRunning = true;
    void rebuildProductLibrary()
      .catch((error) => console.error("[products] 自动重建产品库失败:", error))
      .finally(() => {
        rebuildRunning = false;
      });
  }, delayMs);
}
