import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeReviewState, emptyRowStats, rowStatsByDocument } from "../documents";

describe("文档审核态聚合（跨批次待办 / 批次详情共用口径）", () => {
  it("computeReviewState：冲突优先 > 全确认 > 部分确认 > 待复核", () => {
    assert.equal(computeReviewState({ total: 3, confirmed: 1, conflict: 1 }), "conflict");
    assert.equal(computeReviewState({ total: 3, confirmed: 3, conflict: 0 }), "confirmed");
    assert.equal(computeReviewState({ total: 3, confirmed: 1, conflict: 0 }), "partial");
    assert.equal(computeReviewState({ total: 3, confirmed: 0, conflict: 0 }), "pending");
    assert.equal(computeReviewState(emptyRowStats()), "pending");
  });

  it("rowStatsByDocument：按 (documentId,status) 分组累加为每文档统计", () => {
    const map = rowStatsByDocument([
      { documentId: "d1", status: "confirmed", _count: { _all: 2 } },
      { documentId: "d1", status: "pending", _count: { _all: 1 } },
      { documentId: "d2", status: "conflict", _count: { _all: 1 } },
    ]);
    assert.deepEqual(map.get("d1"), { total: 3, confirmed: 2, conflict: 0 });
    assert.deepEqual(map.get("d2"), { total: 1, confirmed: 0, conflict: 1 });
    assert.equal(map.get("d3"), undefined);
    // 派生态符合预期
    assert.equal(computeReviewState(map.get("d1")!), "partial");
    assert.equal(computeReviewState(map.get("d2")!), "conflict");
  });
});
