import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyLearnedCorrections,
  buildCorrectionMap,
  observationsFromAuditDiff,
  type CorrectionObservation,
} from "../corrections";

const obs = (field: CorrectionObservation["field"], before: string, after: string): CorrectionObservation => ({
  field,
  before,
  after,
});

describe("buildCorrectionMap 纠正记忆", () => {
  it("重复出现达阈值才固化（默认 minOccurrences=2）", () => {
    const once = buildCorrectionMap([obs("name", "雷碧", "雪碧")]);
    assert.equal(once.get("name")?.get("雷碧"), undefined);

    const twice = buildCorrectionMap([obs("name", "雷碧", "雪碧"), obs("name", "雷碧", "雪碧")]);
    assert.equal(twice.get("name")?.get("雷碧"), "雪碧");
  });

  it("矛盾修正不占多数时不固化（dominanceRatio）", () => {
    const map = buildCorrectionMap([
      obs("name", "X", "A"),
      obs("name", "X", "B"),
    ]);
    assert.equal(map.get("name")?.get("x"), undefined);
  });

  it("归一化匹配：全角/空白/大小写差异视为同一 before", () => {
    const map = buildCorrectionMap([obs("unit", "ＫＧ", "千克"), obs("unit", " kg ", "千克")]);
    assert.equal(map.get("unit")?.get("kg"), "千克");
  });

  it("无实质变化（归一后相等）的编辑被忽略", () => {
    const map = buildCorrectionMap([obs("name", "苹果 ", "苹果"), obs("name", " 苹果", "苹果")]);
    assert.equal(map.size, 0);
  });
});

describe("applyLearnedCorrections 套用纠正", () => {
  it("命中则替换，未命中保持原值，空值不动", () => {
    const map = buildCorrectionMap([obs("name", "雷碧", "雪碧"), obs("name", "雷碧", "雪碧")]);
    const hit = applyLearnedCorrections({ name: "雷碧", code: null, unit: null }, map);
    assert.equal(hit.name, "雪碧");
    assert.deepEqual(hit.corrected, ["name"]);

    const miss = applyLearnedCorrections({ name: "可乐", code: null, unit: null }, map);
    assert.equal(miss.name, "可乐");
    assert.deepEqual(miss.corrected, []);
  });
});

describe("observationsFromAuditDiff 解析审计 diff", () => {
  it("只取 name/unit/code 文本字段，忽略数值与非字符串", () => {
    const out = observationsFromAuditDiff(
      { name: "雷碧", price: 3, code: "A1", qty: 0 },
      { name: "雪碧", price: 5, code: "A1", qty: 2 },
    );
    // code 前后相同不会进入（buildCorrectionMap 再过滤），但这里仅做字段提取：name + code 两条
    assert.deepEqual(
      out.map((o) => o.field).sort(),
      ["code", "name"],
    );
  });
});
