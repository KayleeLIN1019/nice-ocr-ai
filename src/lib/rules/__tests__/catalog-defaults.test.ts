import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyModelError,
  RULE_CATALOG_DEFAULTS,
  RULE_CATALOG_DEFAULTS_BY_CODE,
} from "@/lib/rules/catalog-defaults";

describe("classifyModelError", () => {
  it("把常见报错归类到稳定的 ModelErrorCode", () => {
    assert.equal(classifyModelError("Request timed out after 60s"), "MODEL_TIMEOUT");
    assert.equal(classifyModelError("429 Too Many Requests"), "MODEL_RATE_LIMITED");
    assert.equal(classifyModelError("401 Unauthorized: invalid api key"), "MODEL_AUTH_ERROR");
    assert.equal(classifyModelError("insufficient_quota: 余额不足"), "MODEL_QUOTA_EXCEEDED");
    assert.equal(classifyModelError("Unexpected token < in JSON at position 0"), "MODEL_PARSE_ERROR");
    assert.equal(classifyModelError("fetch failed: ECONNREFUSED"), "MODEL_NETWORK_ERROR");
  });

  it("空/无法识别的报错回落 MODEL_UNKNOWN_ERROR", () => {
    assert.equal(classifyModelError(""), "MODEL_UNKNOWN_ERROR");
    assert.equal(classifyModelError(null), "MODEL_UNKNOWN_ERROR");
    assert.equal(classifyModelError("something entirely unexpected"), "MODEL_UNKNOWN_ERROR");
  });

  it("归类结果都在默认字典里有释义", () => {
    const probes = ["timeout", "429", "401", "quota", "json parse", "econnreset", ""];
    for (const probe of probes) {
      const code = classifyModelError(probe);
      assert.ok(RULE_CATALOG_DEFAULTS_BY_CODE[code], `${code} 应在默认字典中`);
    }
  });

  it("默认字典 code 唯一", () => {
    const codes = RULE_CATALOG_DEFAULTS.map((rule) => rule.code);
    assert.equal(new Set(codes).size, codes.length);
  });
});
