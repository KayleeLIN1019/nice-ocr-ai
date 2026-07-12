import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scopeToWhere } from "../exports";

describe("scopeToWhere（选择性导出范围 → where）", () => {
  it("缺省=仅排除已删除（全库兼容）", () => {
    assert.deepEqual(scopeToWhere(), { deletedAt: null });
    assert.deepEqual(scopeToWhere(undefined), { deletedAt: null });
    assert.deepEqual(scopeToWhere({}), { deletedAt: null });
  });

  it("镜像 rows 筛选语义：risk→riskLevel、month→normalizedMonth、默认模糊搜索", () => {
    assert.deepEqual(
      scopeToWhere({
        batchId: "b1",
        status: "confirmed",
        risk: "high",
        auditState: "flagged",
        month: "2024年6月",
        q: " 土豆 ",
        code: " 100 ",
        name: " 土豆 ",
      }),
      {
        deletedAt: null,
        batchId: "b1",
        status: "confirmed",
        riskLevel: "high",
        auditState: "flagged",
        normalizedMonth: "2024年6月",
        OR: [{ code: { contains: "土豆" } }, { name: { contains: "土豆" } }],
        code: { contains: "100" },
        name: { contains: "土豆" },
      },
    );
  });

  it("支持精确搜索：q/code/name 都使用 equals", () => {
    assert.deepEqual(scopeToWhere({ q: "土豆", code: "100", name: "土豆", searchMode: "exact" }), {
      deletedAt: null,
      OR: [{ code: { equals: "土豆" } }, { name: { equals: "土豆" } }],
      code: { equals: "100" },
      name: { equals: "土豆" },
    });
  });

  it("空字符串字段忽略；rowIds 非空才下推 id in", () => {
    assert.deepEqual(scopeToWhere({ status: "", name: "", rowIds: [] }), { deletedAt: null });
    assert.deepEqual(scopeToWhere({ rowIds: ["r1", "r2"] }), { deletedAt: null, id: { in: ["r1", "r2"] } });
  });
});
