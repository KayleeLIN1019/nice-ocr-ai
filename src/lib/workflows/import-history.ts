import ExcelJS from "exceljs";
import { prisma } from "@/lib/db/client";

/**
 * 「副食品采购统计表」历史导入。
 *
 * 文件结构：一个「目录」表 + 每个产品一张分表（表名形如「100001土豆」）。
 * 分表表头含「序号 | 单位 | 各月份… | 评估单价 | 评估金额 | 备注」；月份列是采购数量，
 * 评估单价列实际为空 —— 即本表只提供 编码/名称/单位（及单位的多次样本），不含单价。
 *
 * 因此导入：
 * - Product 产品库：按 编码/名称 去重 upsert，写入名称 + 主导单位（+ 编码，视 withCode）。
 * - ProductPriceHistory(source=import)：每条单位样本一行（price=0），为 #3 的「单位多重校验」提供基线。
 *   单价基线本表无法提供，仍由系统人工确认行逐步积累。
 */

export interface ParsedHistoryProduct {
  code: string | null;
  name: string;
  /** 每条数据行的单位（多样本，供单位多重校验积累足够样本量）。 */
  units: string[];
}

/** 从表名解析编码+名称：前导数字为编码，其余为名称；无前导数字则整名为名称、编码为空。 */
export function parseSheetTitle(title: string): { code: string | null; name: string } {
  const trimmed = title.trim();
  const match = trimmed.match(/^(\d{2,6})\s*(.+)$/);
  if (match && match[2].trim()) return { code: match[1], name: match[2].trim() };
  return { code: null, name: trimmed };
}

/** 取众数（主导值）。 */
function dominant(values: string[]): string | null {
  if (!values.length) return null;
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
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

/** 解析采购统计工作簿：跳过「目录」，每个产品分表提取 编码/名称/单位样本。 */
export async function parsePurchaseHistoryWorkbook(buffer: Buffer): Promise<ParsedHistoryProduct[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);

  const products: ParsedHistoryProduct[] = [];
  for (const ws of workbook.worksheets) {
    if (ws.name.trim() === "目录") continue;

    // 定位「单位」列：扫描前 3 行表头。
    let unitCol = -1;
    let headerRow = -1;
    for (let r = 1; r <= Math.min(3, ws.rowCount) && unitCol < 0; r++) {
      const row = ws.getRow(r);
      for (let c = 1; c <= ws.columnCount; c++) {
        if (String(row.getCell(c).value ?? "").trim() === "单位") {
          unitCol = c;
          headerRow = r;
          break;
        }
      }
    }
    if (unitCol < 0) continue;

    const { code, name } = parseSheetTitle(ws.name);
    if (!name) continue;

    const units: string[] = [];
    for (let r = headerRow + 1; r <= ws.rowCount; r++) {
      const unit = String(ws.getRow(r).getCell(unitCol).value ?? "").trim();
      if (unit) units.push(unit);
    }
    products.push({ code, name, units });
  }
  return products;
}

export interface ImportHistoryResult {
  /** 解析出的产品数（分表数）。 */
  products: number;
  /** 写入 ProductPriceHistory 的单位样本行数。 */
  historyRecords: number;
  /** 产品库新增数。 */
  productsCreated: number;
  /** 产品库更新数。 */
  productsUpdated: number;
  /** 含编码的产品数。 */
  withCode: number;
}

/**
 * 导入采购历史。幂等：先清掉旧的 source=import 历史基线再整体重灌；
 * 产品库按 编码(优先)/名称 去重，已存在则更新名称/单位/编码，否则新建。
 */
export async function importPurchaseHistory(
  buffer: Buffer,
  options?: { withCode?: boolean },
): Promise<ImportHistoryResult> {
  const withCode = options?.withCode ?? true;
  const parsed = await parsePurchaseHistoryWorkbook(buffer);

  // —— 历史基线：先清空旧导入，再批量重灌（每条单位样本一行，price=0）。
  await prisma.productPriceHistory.deleteMany({ where: { source: "import" } });
  let historyRecords = 0;
  let buffered: { code: string | null; name: string; unit: string; price: number; source: string }[] = [];
  const flush = async () => {
    if (!buffered.length) return;
    await prisma.productPriceHistory.createMany({ data: buffered });
    historyRecords += buffered.length;
    buffered = [];
  };

  // —— 产品库：预载现有产品建索引，避免逐条 findFirst（1900+ 产品）。
  const existing = await prisma.product.findMany({ select: { id: true, code: true, name: true } });
  const byCode = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const product of existing) {
    if (product.code) byCode.set(product.code, product.id);
    byName.set(product.name, product.id);
  }

  let withCodeCount = 0;
  let productsCreated = 0;
  let productsUpdated = 0;
  const toCreate: { code: string | null; name: string; unit: string | null }[] = [];

  for (const product of parsed) {
    const code = withCode ? product.code : null;
    if (product.code) withCodeCount += 1;
    const unit = dominant(product.units);

    for (const sample of product.units) {
      buffered.push({ code, name: product.name, unit: sample, price: 0, source: "import" });
      if (buffered.length >= 1000) await flush();
    }

    const matchId = (code && byCode.get(code)) || byName.get(product.name);
    if (matchId === "pending") {
      // 同名产品本次已排队新建（同文件内同名不同编码），归并到首次，跳过。
      continue;
    } else if (matchId) {
      await prisma.product.update({
        where: { id: matchId },
        data: { name: product.name, ...(unit ? { unit } : {}), ...(code ? { code } : {}) },
      });
      productsUpdated += 1;
    } else {
      toCreate.push({ code, name: product.name, unit });
      // 占位防止同名重复新建。
      byName.set(product.name, "pending");
    }
  }
  await flush();

  if (toCreate.length) {
    await prisma.product.createMany({ data: toCreate });
    productsCreated = toCreate.length;
  }

  return {
    products: parsed.length,
    historyRecords,
    productsCreated,
    productsUpdated,
    withCode: withCodeCount,
  };
}
