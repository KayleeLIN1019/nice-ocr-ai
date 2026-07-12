import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { strToU8, zipSync } from "fflate";
import { ingestUpload } from "../ingest";

// ingest 对图片是原样透传（按扩展名判类型，不解码内容），故用任意字节即可当"图片"。
const fakeImage = () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);

describe("ingestUpload 来源溯源", () => {
  it("直传图片 → kind=image，uploadName=文件名，无 entry/page", async () => {
    const out = await ingestUpload("发票001.jpg", fakeImage(), "image/jpeg");
    assert.equal(out.length, 1);
    assert.equal(out[0].name, "发票001.jpg");
    assert.deepEqual(out[0].source, { kind: "image", uploadName: "发票001.jpg" });
  });

  it("ZIP 内图片 → kind=zip-image，带压缩包名与条目路径", async () => {
    const zip = Buffer.from(
      zipSync({
        "2024/a.png": new Uint8Array(fakeImage()),
        "b.jpg": new Uint8Array(fakeImage()),
      }),
    );
    const out = await ingestUpload("档案.zip", zip, "application/zip");
    assert.equal(out.length, 2);

    const a = out.find((item) => item.name === "a.png");
    assert.ok(a, "应展开出 a.png");
    assert.equal(a.source.kind, "zip-image");
    assert.equal(a.source.uploadName, "档案.zip");
    assert.equal(a.source.entryPath, "2024/a.png");
    assert.equal(a.mimeType, "image/png");

    const b = out.find((item) => item.name === "b.jpg");
    assert.ok(b, "应展开出 b.jpg");
    assert.equal(b.source.entryPath, "b.jpg");
  });

  it("ZIP 跳过隐藏文件 / __MACOSX / 不支持格式，只保留可识别内容", async () => {
    const zip = Buffer.from(
      zipSync({
        "keep.png": new Uint8Array(fakeImage()),
        ".DS_Store": strToU8("x"),
        "__MACOSX/._keep.png": new Uint8Array(fakeImage()),
        "notes.txt": strToU8("hello"),
      }),
    );
    const out = await ingestUpload("混合.zip", zip, "application/zip");
    assert.equal(out.length, 1);
    assert.equal(out[0].name, "keep.png");
    assert.equal(out[0].source.kind, "zip-image");
  });

  it("不支持的单文件 → 不产出任何条目", async () => {
    const out = await ingestUpload("readme.txt", Buffer.from("hi"), "text/plain");
    assert.equal(out.length, 0);
  });
});
