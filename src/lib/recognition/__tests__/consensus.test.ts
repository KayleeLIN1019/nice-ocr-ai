import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildConsensusFlags, decideRowReview, type ComparableRow } from "../review";

const row = (over: Partial<ComparableRow>): ComparableRow => ({
  name: "苹果",
  qty: 1,
  price: 1,
  amount: 1,
  ...over,
});

describe("buildConsensusFlags 名称归一化", () => {
  it("全角/半角、大小写、空白差异视为同名（NFKC 归一）", () => {
    const primary = [row({ name: "ＡＢＣ１２３", qty: 2, price: 3, amount: 6 })];
    const secondary = [row({ name: " abc123 ", qty: 2, price: 3, amount: 6 })];
    assert.deepEqual(buildConsensusFlags(primary, secondary), [true]);
  });

  it("不同品名不应判为一致（不做相似度模糊匹配）", () => {
    const primary = [row({ name: "苹果", qty: 2, price: 3, amount: 6 })];
    const secondary = [row({ name: "苹果汁", qty: 2, price: 3, amount: 6 })];
    assert.deepEqual(buildConsensusFlags(primary, secondary), [false]);
  });

  it("同名但金额超出容差不算一致", () => {
    const primary = [row({ name: "苹果", qty: 2, price: 3, amount: 6 })];
    const secondary = [row({ name: "苹果", qty: 2, price: 3, amount: 99 })];
    assert.deepEqual(buildConsensusFlags(primary, secondary), [false]);
  });
});

describe("decideRowReview blockAuto 一票否决", () => {
  it("blockAuto=false 时保持原有自动通过行为", () => {
    assert.deepEqual(decideRowReview("hybrid", "low", true), { status: "confirmed", reviewClass: "ai_auto" });
    assert.deepEqual(decideRowReview("auto", "medium", true), { status: "confirmed", reviewClass: "ai_auto" });
  });

  it("blockAuto=true（如数量为 0）任何模式都不自动通过", () => {
    assert.deepEqual(decideRowReview("hybrid", "low", true, true), {
      status: "needs_review",
      reviewClass: "pending_review",
    });
    assert.deepEqual(decideRowReview("auto", "medium", true, true), {
      status: "needs_review",
      reviewClass: "pending_review",
    });
  });

  it("高风险无视 blockAuto 仍判为冲突", () => {
    assert.deepEqual(decideRowReview("auto", "high", true, true), { status: "conflict", reviewClass: "conflict" });
  });
});
