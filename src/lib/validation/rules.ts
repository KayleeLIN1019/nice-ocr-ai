import type { RecognitionRow } from "@/lib/types";

const invalidNameWords = [
  "合计",
  "总计",
  "小计",
  "备注",
  "单位",
  "数量",
  "单价",
  "金额",
  "日期",
  "电话",
  "地址",
  "经手人",
  "制单人",
  "采购单",
  "销售单",
  "页码",
  "品名",
  "商品名",
  "编号",
  "编码",
  "规格",
  "客户",
  "供货商",
  "供应商",
  "审核",
  "签字",
  "合 计",
];

export function normalizeMonth(value?: string | null) {
  if (!value) return "";
  const text = String(value).trim();
  const cn = text.match(/(\d{4})年(\d{1,2})/);
  if (cn) return `${cn[1]}年${Number(cn[2])}月`;
  const sep = text.match(/(\d{4})[.\-/](\d{1,2})/);
  if (sep) return `${sep[1]}年${Number(sep[2])}月`;
  return "";
}

export function cleanProductCode(code?: string | null) {
  const value = String(code ?? "").trim();
  if (/^\d{4,5}$/.test(value)) return "";
  return value;
}

/** 少于 3 位的非空商品编码多为 OCR 把行号/序号错放到编码列，审核台可一键识别并清空。 */
export function isShortProductCode(code?: string | null) {
  const value = String(code ?? "")
    .normalize("NFKC")
    .trim();
  return value.length > 0 && Array.from(value).length < 3;
}

/**
 * 领域命名规则：商品名中「一级精品」前的两个字必为品牌「雨润」，用于纠正该系列的 OCR 误识
 * （如「雨闰一级精品」「雨 润 一级精品」）。前面不足两字时直接补成「雨润一级精品」。
 * 只做确定性纠错，不改动其它文字。
 */
export function applyBrandRules(name?: string | null): string {
  return String(name ?? "").replace(/[^\s]{0,2}\s*一级精品/g, "雨润一级精品");
}

export function isInvalidProductName(name?: string | null) {
  const value = String(name ?? "").trim();
  if (!value) return true;
  if (/^[\d\s\-—_.,，。:：/\\|]+$/.test(value)) return true;
  if (value.length > 28 && /(地址|电话|公司|门店|备注|说明|合计|总计)/.test(value)) return true;
  return invalidNameWords.some((word) => value === word || value.includes(word));
}

export function validateRow(row: Pick<RecognitionRow, "code" | "name" | "qty" | "price" | "amount">) {
  const reasons: string[] = [];
  const cleanCode = cleanProductCode(row.code);

  if (row.code && row.code !== cleanCode) reasons.push("CODE_CLEANED_BY_RULE");
  if (isInvalidProductName(row.name)) reasons.push("INVALID_PRODUCT_NAME");

  const expected = Number(row.qty || 0) * Number(row.price || 0);
  if (Math.abs(expected - Number(row.amount || 0)) > 0.01) reasons.push("AMOUNT_MISMATCH");
  // 数量为 0（或缺失）多为漏识别/无效行，标记风险以阻止自动通过，交人工核对。
  if (Number(row.qty || 0) <= 0) reasons.push("ZERO_QTY");

  const riskLevel = reasons.some((reason) => reason === "INVALID_PRODUCT_NAME") ? "high" : reasons.length ? "medium" : "low";

  return { riskLevel, reasons, cleanCode };
}
