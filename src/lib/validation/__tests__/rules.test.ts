import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyBrandRules, cleanProductCode, isInvalidProductName, isShortProductCode, normalizeMonth, validateRow } from "../rules";

describe("validation rules", () => {
  it("强制「一级精品」前两字为品牌「雨润」", () => {
    assert.equal(applyBrandRules("雨闰一级精品"), "雨润一级精品");
    assert.equal(applyBrandRules("雨润 一级精品"), "雨润一级精品");
    assert.equal(applyBrandRules("一级精品"), "雨润一级精品");
    assert.equal(applyBrandRules("苹果"), "苹果");
  });

  it("数量为 0 标记 ZERO_QTY 并提升风险", () => {
    const zero = validateRow({ code: "A1001", name: "苹果", qty: 0, price: 3, amount: 0 });
    assert.ok(zero.reasons.includes("ZERO_QTY"));
    assert.equal(zero.riskLevel, "medium");
  });

  it("normalizes supported date formats to Chinese month", () => {
    assert.equal(normalizeMonth("2024-06-15"), "2024年6月");
    assert.equal(normalizeMonth("2024.12.01"), "2024年12月");
    assert.equal(normalizeMonth("2024年7月3日"), "2024年7月");
  });

  it("cleans pure 4 and 5 digit product codes", () => {
    assert.equal(cleanProductCode("1234"), "");
    assert.equal(cleanProductCode("12345"), "");
    assert.equal(cleanProductCode("12"), "12");
    assert.equal(cleanProductCode("A1001"), "A1001");
  });

  it("identifies non-empty product codes shorter than 3 characters", () => {
    assert.equal(isShortProductCode("1"), true);
    assert.equal(isShortProductCode(" A "), true);
    assert.equal(isShortProductCode("１２"), true);
    assert.equal(isShortProductCode("123"), false);
    assert.equal(isShortProductCode(""), false);
    assert.equal(isShortProductCode(null), false);
  });

  it("marks summary words as invalid product names", () => {
    assert.equal(isInvalidProductName("合计"), true);
    assert.equal(isInvalidProductName("商品名"), true);
    assert.equal(isInvalidProductName("苹果"), false);
  });

  it("raises risk for invalid names and amount mismatch", () => {
    const invalid = validateRow({ code: "", name: "合计", qty: 2, price: 3, amount: 9 });
    assert.equal(invalid.riskLevel, "high");
    assert.deepEqual(invalid.reasons, ["INVALID_PRODUCT_NAME", "AMOUNT_MISMATCH"]);

    const clean = validateRow({ code: "A1001", name: "苹果", qty: 2, price: 3, amount: 6 });
    assert.equal(clean.riskLevel, "low");
  });
});
