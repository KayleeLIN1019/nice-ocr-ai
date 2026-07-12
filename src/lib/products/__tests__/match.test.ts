import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { levSimilarity, matchLibraryCandidates, normalizeMatchKey } from "../match";

const library = [
  { name: "鸭舌", unit: "袋", price: 30 },
  { name: "鸭肠", unit: "袋", price: 50 },
  { name: "鸡毛肚", unit: "斤", price: 5 },
].map((product) => ({ ...product, norm: normalizeMatchKey(product.name) }));

describe("产品库模糊匹配", () => {
  it("相似度：完全一致=1，两字差一字=0.5", () => {
    assert.equal(levSimilarity("鸭舌", "鸭舌"), 1);
    assert.equal(levSimilarity("鸭舌", "鸭古"), 0.5);
  });

  it("名字已是库内商品 → 不给建议（名字已正确）", () => {
    assert.deepEqual(matchLibraryCandidates({ name: "鸭舌", unit: "袋", price: 30 }, library), []);
  });

  it("可疑名按相似度+单价匹配出带置信度的候选", () => {
    const result = matchLibraryCandidates({ name: "鸭古", unit: "袋", price: 30 }, library);
    assert.equal(result[0]?.name, "鸭舌");
    assert.ok(result[0].confidence > 0 && result[0].confidence <= 100);
  });

  it("名称太不像 → 不给候选（单价相同也不行，避免凭巧合改名）", () => {
    assert.deepEqual(matchLibraryCandidates({ name: "西瓜", unit: "斤", price: 30 }, library), []);
  });
});
