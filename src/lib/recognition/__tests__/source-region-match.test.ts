import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { matchRowsToLayout } from "../source-region-match";
import type { OcrLayoutResult } from "../ocr-layout";

/** 构造一张票的合成 OCR 版面：每行由编码/名称/金额多段文字组成，y 略有抖动。 */
function layout(): OcrLayoutResult {
  return {
    width: 1489,
    height: 2105,
    lines: [
      // 行带 A（y≈0.300）：编码 300529
      { text: "300529", score: 0.99, box: { x: 0.282, y: 0.3, w: 0.06, h: 0.013 } },
      { text: "雨润缠肘子", score: 0.98, box: { x: 0.36, y: 0.301, w: 0.12, h: 0.013 } },
      { text: "233.45", score: 0.97, box: { x: 0.7, y: 0.3, w: 0.09, h: 0.013 } },
      // 行带 B（y≈0.315）：编码 300537
      { text: "300537", score: 0.99, box: { x: 0.282, y: 0.315, w: 0.06, h: 0.013 } },
      { text: "雨润纹精品肉丝", score: 0.98, box: { x: 0.36, y: 0.315, w: 0.16, h: 0.013 } },
      { text: "89.9", score: 0.97, box: { x: 0.72, y: 0.315, w: 0.07, h: 0.013 } },
      // 行带 C（y≈0.328）：OCR 未识出编码，仅有名称/金额 → 走名称兜底
      { text: "甲肉", score: 0.96, box: { x: 0.36, y: 0.328, w: 0.05, h: 0.013 } },
      { text: "165.55", score: 0.95, box: { x: 0.7, y: 0.328, w: 0.09, h: 0.013 } },
    ],
  };
}

describe("matchRowsToLayout（OCR 版面 → 行级原图区域）", () => {
  it("按商品编码精确匹配，行带多段文字聚成全宽包围盒", () => {
    const result = matchRowsToLayout([{ code: "300529", name: "雨润 缠肘子" }], layout());
    const region = result[0];
    assert.ok(region);
    assert.equal(region.source, "layout_ocr");
    // 包围盒并集：左到编码列、右到金额列。
    assert.ok(Math.abs(region.box.x - 0.282) < 1e-6);
    assert.ok(region.box.x + region.box.w > 0.78);
    assert.ok(Math.abs(region.box.y - 0.3) < 1e-6);
    assert.ok(region.box.w > 0 && region.box.h > 0);
  });

  it("编码缺失时按名称相似度兜底匹配", () => {
    const result = matchRowsToLayout([{ code: "140001", name: "甲肉" }], layout());
    const region = result[0];
    assert.ok(region);
    assert.equal(region.source, "layout_ocr");
    // 命中行带 C（y≈0.328）。
    assert.ok(Math.abs(region.box.y - 0.328) < 1e-6);
  });

  it("多行各自命中正确行带且行带不复用", () => {
    const rows = [
      { code: "300537", name: "雨润 纹精品肉丝" },
      { code: "300529", name: "雨润 缠肘子" },
      { code: "140001", name: "甲肉" },
    ];
    const result = matchRowsToLayout(rows, layout());
    assert.ok(Math.abs(result[0]!.box.y - 0.315) < 1e-6);
    assert.ok(Math.abs(result[1]!.box.y - 0.3) < 1e-6);
    assert.ok(Math.abs(result[2]!.box.y - 0.328) < 1e-6);
    // 三行映射到三个不同行带。
    const ys = result.map((r) => r!.box.y);
    assert.equal(new Set(ys).size, 3);
  });

  it("无法匹配的行返回 undefined，不误命中", () => {
    const result = matchRowsToLayout([{ code: "999999", name: "不存在的商品ABC" }], layout());
    assert.equal(result[0], undefined);
  });

  it("坐标统一 clamp 到 0..1", () => {
    const overflow: OcrLayoutResult = {
      width: 100,
      height: 100,
      lines: [{ text: "300529", score: 0.9, box: { x: 0.95, y: 0.97, w: 0.2, h: 0.2 } }],
    };
    const region = matchRowsToLayout([{ code: "300529", name: "x" }], overflow)[0];
    assert.ok(region);
    assert.ok(region.box.x + region.box.w <= 1 + 1e-9);
    assert.ok(region.box.y + region.box.h <= 1 + 1e-9);
  });
});
