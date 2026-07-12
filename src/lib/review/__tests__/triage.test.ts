import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDocumentTriage, buildRowTriage } from "@/lib/review/triage";

const baseRow = {
  id: "row_1",
  code: "YR001",
  name: "雨润一级精品",
  unit: "斤",
  qty: 2,
  price: 10,
  amount: 20,
  status: "pending",
  riskLevel: "low",
  riskReasonsJson: "[]",
  auditState: "none",
};

describe("review triage", () => {
  it("marks a clean pending row as auto-pass candidate", () => {
    const triage = buildRowTriage(baseRow);
    assert.equal(triage.queue, "auto_pass");
    assert.equal(triage.needsHuman, false);
    assert.deepEqual(triage.fieldIssues, []);
  });

  it("blocks document auto pass when a row has amount mismatch", () => {
    const triage = buildDocumentTriage([{ ...baseRow, amount: 19, riskReasonsJson: JSON.stringify(["AMOUNT_MISMATCH"]) }]);
    assert.equal(triage.document.autoPassEligible, false);
    assert.equal(triage.document.queue, "manual");
    assert.equal(triage.rows[0].fieldIssues.some((issue) => issue.field === "amount"), true);
  });

  it("adds a safe clear-code action for short product codes", () => {
    const triage = buildRowTriage({ ...baseRow, code: "1" });
    const codeIssue = triage.fieldIssues.find((issue) => issue.code === "SHORT_PRODUCT_CODE");
    assert.equal(codeIssue?.field, "code");
    assert.equal(codeIssue?.action, "clear_code");
    assert.equal(triage.queue, "manual");
  });

  it("allows document auto pass when all active rows are clean", () => {
    const triage = buildDocumentTriage([baseRow, { ...baseRow, id: "row_2", status: "confirmed" }]);
    assert.equal(triage.document.autoPassEligible, true);
    assert.equal(triage.document.queue, "auto_pass");
    assert.equal(triage.document.rowCounts.autoPass, 1);
  });

  it("blocks auto pass for non-low risk rows even when field issues are empty", () => {
    const triage = buildDocumentTriage([{ ...baseRow, riskLevel: "medium" }]);
    assert.equal(triage.document.autoPassEligible, false);
    assert.equal(triage.rows[0].needsHuman, true);
  });
});
