import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildExtractionResultSchema,
  extractionResultSchema,
  normalizeExtractionWith,
} from "../schema";
import { buildRecognitionPrompt, defaultRecognitionPrompts } from "../settings";
import { extractionConfigForScenario } from "../provider";
import { getScenario, getScenarioFields, type FieldDef, type FieldScenario } from "@/lib/fields/field-schema";

describe("scenario 驱动抽取（动态 schema / prompt）", () => {
  it("grocery 动态 schema 与默认 schema 解析等价（零行为变更）", () => {
    const fields = getScenarioFields("grocery");
    const raw = {
      date: "2024-06-01",
      items: [{ code: "A", name: "苹果", unit: "kg", qty: "2", price: "3", amount: "6", remark: "" }],
    };
    assert.deepEqual(buildExtractionResultSchema(fields).parse(raw), extractionResultSchema.parse(raw));
  });

  it("buildRecognitionPrompt：grocery 返回内置默认；非默认场景按字段生成", () => {
    assert.deepEqual(buildRecognitionPrompt(getScenario("grocery"), getScenarioFields("grocery")), {
      systemPrompt: defaultRecognitionPrompts.systemPrompt,
      userPrompt: defaultRecognitionPrompts.userPrompt,
    });

    const scenario: FieldScenario = { id: "custom", name: "建材采购单", description: "", fieldKeys: [] };
    const fields: FieldDef[] = [
      { key: "name", label: "材料名", type: "text", core: true, editable: true },
      { key: "spec", label: "规格", type: "text", core: false, editable: true, recognitionHint: "如 M8x40" },
    ];
    const prompt = buildRecognitionPrompt(scenario, fields);
    assert.match(prompt.systemPrompt, /建材采购单/);
    assert.match(prompt.systemPrompt, /材料名/);
    assert.match(prompt.systemPrompt, /规格（如 M8x40）/);
  });

  it("normalizeExtractionWith 把非核心字段拆进 extra、核心列留在行上", () => {
    const fields: FieldDef[] = [
      { key: "name", label: "名称", type: "text", core: true, editable: true },
      { key: "qty", label: "数量", type: "number", core: true, editable: true },
      { key: "spec", label: "规格", type: "text", core: false, editable: true },
    ];
    const result = normalizeExtractionWith({ date: "2024.06", items: [{ name: "螺丝", qty: 10, spec: "M8" }] }, fields);
    assert.equal(result.normalizedMonth, "2024年6月");
    assert.equal(result.rows[0].name, "螺丝");
    assert.equal(result.rows[0].qty, 10);
    assert.deepEqual(result.rows[0].extra, { spec: "M8" });
  });

  it("normalizeExtractionWith 保留合法 sourceRegion 并 clamp 越界坐标", () => {
    const fields: FieldDef[] = [
      { key: "name", label: "名称", type: "text", core: true, editable: true },
      { key: "qty", label: "数量", type: "number", core: true, editable: true },
    ];
    const result = normalizeExtractionWith(
      {
        date: "2024.06",
        items: [{ name: "螺丝", qty: 10, sourceRegion: { x: 0.8, y: -0.1, w: 0.5, h: 0.2, confidence: 1.2 } }],
      },
      fields,
    );
    assert.deepEqual(result.rows[0].sourceRegion, {
      version: 1,
      source: "model",
      kind: "row",
      box: { x: 0.8, y: 0, w: 0.19999999999999996, h: 0.2 },
      confidence: 1,
    });
  });

  it("normalizeExtractionWith 忽略非法 sourceRegion 且不影响业务字段", () => {
    const fields: FieldDef[] = [
      { key: "name", label: "名称", type: "text", core: true, editable: true },
      { key: "qty", label: "数量", type: "number", core: true, editable: true },
    ];
    const result = normalizeExtractionWith(
      { date: "2024.06", items: [{ name: "螺丝", qty: 10, sourceRegion: { x: "bad", y: 0.1, w: 0.2, h: 0.1 } }] },
      fields,
    );
    assert.equal(result.rows[0].name, "螺丝");
    assert.equal(result.rows[0].sourceRegion, undefined);
  });

  it("extractionConfigForScenario：默认场景复用同一份 grocery 默认配置", () => {
    assert.equal(extractionConfigForScenario("grocery"), extractionConfigForScenario(null));
  });
});
