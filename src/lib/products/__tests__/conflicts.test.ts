import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectProductConflictReasons } from "../conflicts";

describe("product conflict detection", () => {
  it("detects invalid names, code conflicts, multi-code and multi-unit notes", () => {
    const reasons = detectProductConflictReasons([
      { rowId: "1", code: "A1001", name: "苹果", unit: "kg" },
      { rowId: "2", code: "A1001", name: "苹果果", unit: "kg" },
      { rowId: "3", code: "B2001", name: "香蕉", unit: "kg" },
      { rowId: "4", code: "B2002", name: "香蕉", unit: "斤" },
      { rowId: "5", code: "1234", name: "合计", unit: "" },
      { rowId: "6", code: "1", name: "梨", unit: "斤" },
      { rowId: "7", code: "P100", name: "梨", unit: "斤" },
    ]);

    assert.deepEqual(reasons.get("1"), ["CODE_NAME_CONFLICT"]);
    assert.deepEqual(reasons.get("2"), ["CODE_NAME_CONFLICT"]);
    assert.deepEqual(reasons.get("3"), ["NAME_MULTI_CODE", "NAME_MULTI_UNIT"]);
    assert.deepEqual(reasons.get("4"), ["NAME_MULTI_CODE", "NAME_MULTI_UNIT"]);
    assert.deepEqual(reasons.get("5"), ["INVALID_PRODUCT_NAME", "CODE_CLEANED_BY_RULE"]);
    assert.deepEqual(reasons.get("6"), []);
    assert.deepEqual(reasons.get("7"), []);
  });
});
