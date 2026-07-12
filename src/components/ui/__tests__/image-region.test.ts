import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { regionStyle, viewportForRegion } from "../image-region";

describe("image region viewport math", () => {
  it("maps normalized boxes to rendered image pixels", () => {
    assert.deepEqual(regionStyle({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, { width: 1000, height: 500 }), {
      left: 100,
      top: 100,
      width: 300,
      height: 200,
    });
  });

  it("centers a target region on a wide image", () => {
    const box = { x: 0.6, y: 0.25, w: 0.1, h: 0.08 };
    const image = { width: 1600, height: 600 };
    const canvas = { width: 800, height: 500 };
    const viewport = viewportForRegion(box, image, canvas);
    const centerX = image.width * (box.x + box.w / 2);
    const centerY = image.height * (box.y + box.h / 2);

    assert.equal(centerX * viewport.zoom + viewport.pan.x, canvas.width / 2);
    assert.equal(centerY * viewport.zoom + viewport.pan.y, canvas.height / 2);
  });

  it("centers a target region on a tall image", () => {
    const box = { x: 0.15, y: 0.72, w: 0.5, h: 0.04 };
    const image = { width: 600, height: 1800 };
    const canvas = { width: 720, height: 640 };
    const viewport = viewportForRegion(box, image, canvas);
    const centerX = image.width * (box.x + box.w / 2);
    const centerY = image.height * (box.y + box.h / 2);

    assert.equal(centerX * viewport.zoom + viewport.pan.x, canvas.width / 2);
    assert.equal(centerY * viewport.zoom + viewport.pan.y, canvas.height / 2);
  });
});
