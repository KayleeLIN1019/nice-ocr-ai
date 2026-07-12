import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  COMMON_CORE_FIELD_KEYS,
  DEFAULT_SCENARIO_ID,
  distinctScenarioIds,
  getCommonCoreFields,
  getScenarioFields,
} from "../field-schema";

describe("作用域字段解析（混场景退化 / 按场景出列）", () => {
  it("distinctScenarioIds：去重并保持顺序，未知/空回退默认场景", () => {
    assert.deepEqual(distinctScenarioIds(["grocery", "grocery"]), ["grocery"]);
    assert.deepEqual(distinctScenarioIds([null, undefined, ""]), [DEFAULT_SCENARIO_ID]);
    assert.deepEqual(distinctScenarioIds(["unknown-x"]), [DEFAULT_SCENARIO_ID]);
    // 顺序稳定：先出现先排；无效项归一到默认后不再重复。
    assert.deepEqual(distinctScenarioIds(["grocery", null]), ["grocery"]);
  });

  it("getCommonCoreFields：返回公共核心识别列（与键表一致、全部为核心字段）", () => {
    const fields = getCommonCoreFields();
    assert.deepEqual(fields.map((f) => f.key), [...COMMON_CORE_FIELD_KEYS]);
    assert.ok(fields.every((f) => f.core));
  });

  it("getScenarioFields：按场景出列是纯函数，重复调用结果稳定且不依赖全局状态", () => {
    const a = getScenarioFields("grocery");
    const b = getScenarioFields("grocery");
    assert.deepEqual(a.map((f) => f.key), b.map((f) => f.key));
    // 未知场景回退默认场景字段（与 grocery 等价）
    assert.deepEqual(getScenarioFields("nope").map((f) => f.key), getScenarioFields(DEFAULT_SCENARIO_ID).map((f) => f.key));
  });
});
