import assert from "node:assert/strict";
import { describe, it } from "node:test";
import ExcelJS from "exceljs";
import {
  DEFAULT_EXPORT_TEMPLATE_ID,
  exportCellValue,
  extractPivotRows,
  getExportTemplate,
  listExportTemplates,
  resolveTemplateColumns,
  writePivotWorkbook,
  type ExportSourceRow,
  type PivotExportTemplate,
} from "../export-templates";
import type { FieldDef } from "@/lib/fields/field-schema";

function mkRow(partial: Partial<ExportSourceRow>): ExportSourceRow {
  return {
    batch: { name: "B1" },
    document: { originalName: "doc.jpg" },
    name: "",
    qty: 0,
    price: 0,
    amount: 0,
    status: "confirmed",
    riskLevel: "low",
    ...partial,
  };
}

/** v5 原版导出的 14 列（顺序固定）。 */
const V5_HEADERS = [
  "图片名",
  "图片标签",
  "原始日期",
  "归一化月份",
  "商品编码",
  "商品名",
  "单位",
  "数量",
  "单价",
  "金额",
  "状态",
  "备注",
  "资料库冲突",
  "冲突原因",
];

describe("export templates", () => {
  it("默认模板为 v5-20260618（flat），并内置采购统计表 pivot 模板", () => {
    assert.equal(DEFAULT_EXPORT_TEMPLATE_ID, "v5-20260618");
    const list = listExportTemplates();
    assert.equal(list.length, 2);
    assert.equal(list[0].id, "v5-20260618");
    assert.equal(list[0].name, "recognition result");
    assert.equal(list[0].kind, "flat");
    const pivot = list.find((t) => t.id === "purchase-stats-20260619");
    assert.equal(pivot?.name, "副食品采购统计表");
    assert.equal(pivot?.kind, "pivot");
  });

  it("v5-20260618 的列与 v5 原版完全一致（列名/顺序）", () => {
    const template = getExportTemplate("v5-20260618");
    const columns = resolveTemplateColumns(template, "grocery");
    assert.deepEqual(columns.map((c) => c.label), V5_HEADERS);
    // 数字列带 v5 数字格式
    const qty = columns.find((c) => c.key === "qty");
    const amount = columns.find((c) => c.key === "amount");
    assert.equal(qty?.numFmt, "#,##0.##");
    assert.equal(amount?.numFmt, "#,##0.00");
  });

  it("未知 templateId 回退到默认模板", () => {
    assert.equal(getExportTemplate("does-not-exist").id, "v5-20260618");
  });

  it("exportCellValue 对元/派生字段的取值与 v5 语义一致", () => {
    const row: ExportSourceRow = {
      batch: { name: "B1" },
      document: { originalName: "img.jpg", tag: "T1" },
      rawDate: "2024.06",
      normalizedMonth: "2024年6月",
      code: "A1",
      name: "苹果",
      unit: "箱",
      qty: 2,
      price: 3.5,
      amount: 7,
      remark: "r",
      extraJson: JSON.stringify({ spec: "大包" }),
      status: "confirmed",
      riskLevel: "low",
      conflictState: "open",
      riskReasonsJson: JSON.stringify(["名称异常", "金额不符"]),
    };
    const field = (key: string, type: FieldDef["type"] = "text", core = true): FieldDef => ({
      key,
      label: key,
      type,
      core,
      editable: false,
    });

    assert.equal(exportCellValue(row, field("document")), "img.jpg");
    assert.equal(exportCellValue(row, field("tag")), "T1");
    assert.equal(exportCellValue(row, field("status")), "已确认"); // 英文枚举 → 中文
    assert.equal(exportCellValue(row, field("libraryConflict")), "是"); // conflictState=open
    assert.equal(exportCellValue(row, field("libraryConflictReason")), "名称异常；金额不符");
    assert.equal(exportCellValue(row, field("amount", "number")), 7);
    // 非核心字段从 extraJson 读取
    assert.equal(exportCellValue(row, field("spec", "text", false)), "大包");
  });
});

describe("pivot 模板（采购统计表透视）", () => {
  const template = getExportTemplate("purchase-stats-20260619") as PivotExportTemplate;
  const rows: ExportSourceRow[] = [
    mkRow({ code: "100001", name: "土豆", unit: "斤", qty: 20, price: 4, normalizedMonth: "2020年1月" }),
    mkRow({ code: "100001", name: "土豆", unit: "斤", qty: 30, price: 6, normalizedMonth: "2019年12月" }),
    mkRow({ code: "100005", name: "白萝卜", unit: "斤", qty: 11, price: 3, normalizedMonth: "2020年1月" }),
  ];

  async function build() {
    const workbook = new ExcelJS.Workbook();
    writePivotWorkbook(workbook, template, rows);
    return workbook;
  }

  it("生成 目录 + 每产品一个 sheet（sheet 名=编码+名称）", async () => {
    const wb = await build();
    assert.deepEqual(
      wb.worksheets.map((s) => s.name),
      ["目录", "100001土豆", "100005白萝卜"],
    );
  });

  it("目录页按顺序列出 序号/产品名", async () => {
    const wb = await build();
    const toc = wb.getWorksheet("目录")!;
    assert.equal(toc.getCell("A1").value, "序号");
    assert.equal(toc.getCell("B1").value, "产品名");
    assert.equal(toc.getCell("A2").value, 1);
    assert.deepEqual(toc.getCell("B2").value, { text: "100001土豆", hyperlink: "#'100001土豆'!A1" });
    assert.equal(toc.getCell("A3").value, 2);
    assert.deepEqual(toc.getCell("B3").value, { text: "100005白萝卜", hyperlink: "#'100005白萝卜'!A1" });
  });

  it("单产品 sheet：合并标题 + 月份列降序 + 数量落格 + 评估列计算", async () => {
    const wb = await build();
    const sheet = wb.getWorksheet("100001土豆")!;
    // R1 合并标题
    assert.equal(sheet.getCell("A1").value, "土豆采购统计表");
    // R2 表头：序号|单位|2020年1月|2019年12月|评估单价|评估金额|备注（月份降序）
    assert.deepEqual(
      [1, 2, 3, 4, 5, 6, 7].map((c) => sheet.getRow(2).getCell(c).value),
      ["序号", "单位", "2020年1月", "2019年12月", "评估单价", "评估金额", "备注"],
    );
    // R3：序号=1、单位=斤、2020年1月=20、评估单价=均值(4,6)=5、评估金额=5×(20+30)=250
    assert.equal(sheet.getCell("A3").value, 1);
    assert.equal(sheet.getCell("B3").value, "斤");
    assert.equal(sheet.getCell("C3").value, 20);
    assert.equal(sheet.getCell("E3").value, 5);
    assert.equal(sheet.getCell("F3").value, 250);
    // R4：第二条记录落在 2019年12月 列
    assert.equal(sheet.getCell("D4").value, 30);
    // 评估列只在首行
    assert.equal(sheet.getCell("E4").value, null);
  });

  it("extractPivotRows 反向解析：写盘读回还原出行（追加/合并基础）", async () => {
    const wb = await build();
    const buffer = await wb.xlsx.writeBuffer();
    const back = new ExcelJS.Workbook();
    await back.xlsx.load(buffer as Parameters<typeof back.xlsx.load>[0]);
    const recovered = extractPivotRows(back, template);

    assert.equal(recovered.length, 3);
    const potato = recovered.filter((row) => row.name === "土豆");
    assert.equal(potato.length, 2);
    assert.equal(potato[0].code, "100001");
    assert.equal(potato[0].unit, "斤");
    assert.deepEqual(potato.map((row) => row.qty).sort((a, b) => a - b), [20, 30]);
    assert.deepEqual(potato.map((row) => row.normalizedMonth).sort(), ["2019年12月", "2020年1月"]);
  });

  it("extractPivotRows 对非采购统计表结构抛错", () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("随便一张表");
    assert.throws(() => extractPivotRows(wb, template), /不是有效/);
  });
});
