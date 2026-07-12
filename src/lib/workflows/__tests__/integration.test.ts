import assert from "node:assert/strict";
import { describe, it } from "node:test";
import ExcelJS from "exceljs";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../db/client";
import { enqueueRecognitionJob, enqueueSecondPassIfNeeded, claimNextJob } from "../../queue/jobs";
import { appendRecognitionExport, buildProductExport, buildRecognitionExport } from "../exports";
import { getExportTemplate } from "../export-templates";
import { importLegacyRecognitionRows } from "../import-v5";
import { rebuildProductLibrary } from "../products";
import {
  clearShortProductCodes,
  confirmRecognitionRows,
  createRecognitionRow,
  excludeRecognitionRow,
  replaceProductCodesByName,
  replaceProductNamesByCode,
  updateRecognitionRow,
} from "../rows";
import { resolveProductConflict } from "../conflicts";
import { buildConsensusFlags, decideRowReview, shouldRunConsensus } from "../../recognition/review";
import { ensureSourceRegionInstruction, resolveProviderPrompts } from "../../recognition/provider";
import { defaultRecognitionPrompts, sourceRegionPromptInstruction } from "../../recognition/settings";
import { auditRowByRules, buildAuditStats, findDuplicateRowIds } from "../../recognition/audit";
import { serializeSourceRegion } from "../../recognition/source-region";

const rollback = Symbol("rollback");

async function withRollback<T>(callback: (tx: Prisma.TransactionClient) => Promise<T>) {
  try {
    await prisma.$transaction(async (tx) => {
      await callback(tx);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}

async function readWorkbook(buffer: Buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  return workbook;
}

describe("workflow integration", () => {
  it("imports legacy rows into batch, documents and normalized recognition rows", async () => {
    await withRollback(async (tx) => {
      const result = await importLegacyRecognitionRows(
        [
          {
            image_name: "ticket-a.jpg",
            image_tag: "A",
            raw_date: "2024-06-15",
            code: "1234",
            name: "合计",
            unit: "",
            qty: 2,
            price: 3,
            amount: 9,
          },
          {
            image_name: "ticket-a.jpg",
            raw_date: "2024-06-16",
            code: "A1001",
            name: "苹果",
            unit: "kg",
            qty: 2,
            price: 3,
            amount: 6,
            status: "已确认",
          },
        ],
        tx,
      );

      assert.equal(result.documents, 1);
      assert.equal(result.rows, 2);

      const rows = await tx.recognitionRow.findMany({
        where: { batchId: result.batch.id },
        orderBy: { rowIndex: "asc" },
      });

      assert.equal(rows[0].normalizedMonth, "2024年6月");
      assert.equal(rows[0].riskLevel, "high");
      assert.deepEqual(JSON.parse(rows[0].riskReasonsJson), [
        "CODE_CLEANED_BY_RULE",
        "INVALID_PRODUCT_NAME",
        "AMOUNT_MISMATCH",
      ]);
      assert.equal(rows[1].status, "confirmed");
    });
  });

  it("claims queued jobs and prevents duplicate second-pass jobs", async () => {
    await withRollback(async (tx) => {
      const batch = await tx.batch.create({ data: { name: "queue-test" } });
      const document = await tx.document.create({
        data: {
          batchId: batch.id,
          originalName: "queue.jpg",
          storedPath: "",
          hash: "queue-hash",
          mimeType: "image/jpeg",
          sizeBytes: 0,
        },
      });

      const job = await enqueueRecognitionJob(document.id, batch.id, "extract", tx);
      const firstSecondPass = await enqueueSecondPassIfNeeded(document.id, batch.id, tx);
      const duplicateSecondPass = await enqueueSecondPassIfNeeded(document.id, batch.id, tx);
      const claimed = await claimNextJob("worker-test", tx);

      assert.ok(job);
      assert.equal(firstSecondPass?.type, "second_pass");
      assert.equal(duplicateSecondPass, null);
      assert.equal(claimed?.id, job.id);
      assert.equal(claimed?.status, "active");
      assert.equal(claimed?.attemptsMade, 1);
      assert.equal(claimed?.lockedBy, "worker-test");
    });
  });

  it("updates rows with audit log and supports soft exclusion", async () => {
    await withRollback(async (tx) => {
      const batch = await tx.batch.create({ data: { name: "row-edit-test" } });
      const document = await tx.document.create({
        data: {
          batchId: batch.id,
          originalName: "row.jpg",
          storedPath: "",
          hash: "row-hash",
          mimeType: "image/jpeg",
          sizeBytes: 0,
        },
      });
      const original = await tx.recognitionRow.create({
        data: {
          batchId: batch.id,
          documentId: document.id,
          rowIndex: 1,
          name: "苹果",
          qty: 1,
          price: 2,
          amount: 2,
        },
      });

      const updated = await updateRecognitionRow(
        original.id,
        { name: "合计", qty: 1, price: 2, amount: 3 },
        tx,
      );
      const auditCount = await tx.auditLog.count({
        where: { entityType: "RecognitionRow", entityId: original.id, action: "update" },
      });
      const excluded = await excludeRecognitionRow(original.id, tx);

      assert.equal(updated?.riskLevel, "high");
      assert.deepEqual(JSON.parse(updated?.riskReasonsJson ?? "[]"), [
        "INVALID_PRODUCT_NAME",
        "AMOUNT_MISMATCH",
      ]);
      assert.equal(auditCount, 1);
      assert.equal(excluded?.status, "excluded");
      assert.ok(excluded?.deletedAt);
      // 软删除应留痕 AuditLog(action=exclude)，便于追溯。
      const excludeAuditCount = await tx.auditLog.count({
        where: { entityType: "RecognitionRow", entityId: original.id, action: "exclude" },
      });
      assert.equal(excludeAuditCount, 1);
    });
  });

  it("persists recognized row sourceRegionJson for image review positioning", async () => {
    await withRollback(async (tx) => {
      const batch = await tx.batch.create({ data: { name: "source-region-test" } });
      const document = await tx.document.create({
        data: {
          batchId: batch.id,
          originalName: "source-region.jpg",
          storedPath: "",
          hash: "source-region-hash",
          mimeType: "image/jpeg",
          sizeBytes: 0,
        },
      });
      const sourceRegion = {
        version: 1 as const,
        source: "model" as const,
        kind: "row" as const,
        box: { x: 0.12, y: 0.34, w: 0.56, h: 0.08 },
        confidence: 0.72,
      };

      const row = await tx.recognitionRow.create({
        data: {
          batchId: batch.id,
          documentId: document.id,
          rowIndex: 1,
          name: "苹果",
          qty: 2,
          price: 3,
          amount: 6,
          sourceRegionJson: serializeSourceRegion(sourceRegion),
        },
      });

      const saved = await tx.recognitionRow.findUniqueOrThrow({ where: { id: row.id } });
      assert.deepEqual(JSON.parse(saved.sourceRegionJson ?? "{}"), sourceRegion);
    });
  });

  it("creates rows with audit log; inline insertion shifts following rows", async () => {
    await withRollback(async (tx) => {
      const batch = await tx.batch.create({ data: { name: "row-create-test" } });
      const document = await tx.document.create({
        data: {
          batchId: batch.id,
          originalName: "create.jpg",
          storedPath: "",
          hash: "row-create-hash",
          mimeType: "image/jpeg",
          sizeBytes: 0,
        },
      });
      await tx.recognitionRow.createMany({
        data: [
          { batchId: batch.id, documentId: document.id, rowIndex: 1, name: "苹果" },
          { batchId: batch.id, documentId: document.id, rowIndex: 2, name: "香蕉" },
        ],
      });
      const first = await tx.recognitionRow.findFirst({
        where: { documentId: document.id, rowIndex: 1 },
      });

      // 末尾追加：rowIndex = max + 1 = 3；人工新增标记；金额自洽判低风险
      const appended = await createRecognitionRow(
        { documentId: document.id, name: "橙子", qty: 2, price: 3, amount: 6 },
        tx,
      );
      assert.ok(appended);
      assert.equal(appended.rowIndex, 3);
      assert.equal(appended.reviewClass, "human");
      assert.equal(appended.status, "pending");
      assert.equal(appended.riskLevel, "low");

      // 新建应留痕 AuditLog(action=create)
      const createAuditCount = await tx.auditLog.count({
        where: { entityType: "RecognitionRow", entityId: appended.id, action: "create" },
      });
      assert.equal(createAuditCount, 1);

      // 在第 1 行下方插入：新行 rowIndex=2，原第 2、3 行整体下移到 3、4
      const inserted = await createRecognitionRow(
        { documentId: document.id, afterRowId: first?.id, name: "葡萄" },
        tx,
      );
      assert.ok(inserted);
      assert.equal(inserted.rowIndex, 2);

      const ordered = await tx.recognitionRow.findMany({
        where: { documentId: document.id, deletedAt: null },
        orderBy: { rowIndex: "asc" },
      });
      assert.deepEqual(
        ordered.map((row) => [row.rowIndex, row.name]),
        [
          [1, "苹果"],
          [2, "葡萄"],
          [3, "香蕉"],
          [4, "橙子"],
        ],
      );

      // 非法名称判高风险；文档不存在返回 null
      const flagged = await createRecognitionRow({ documentId: document.id, name: "合计" }, tx);
      assert.equal(flagged?.riskLevel, "high");
      const missing = await createRecognitionRow({ documentId: "nonexistent" }, tx);
      assert.equal(missing, null);
    });
  });

  it("rebuilds product library and exports recognition/product workbooks", async () => {
    await withRollback(async (tx) => {
      const batch = await tx.batch.create({ data: { name: "export-test" } });
      const document = await tx.document.create({
        data: {
          batchId: batch.id,
          originalName: "export.jpg",
          storedPath: "",
          hash: "export-hash",
          mimeType: "image/jpeg",
          sizeBytes: 0,
        },
      });
      await tx.recognitionRow.createMany({
        data: [
          {
            batchId: batch.id,
            documentId: document.id,
            rowIndex: 1,
            normalizedMonth: "2024年6月",
            code: "A1001",
            name: "苹果",
            unit: "kg",
            qty: 2,
            price: 3,
            amount: 6,
            status: "confirmed",
          },
          {
            batchId: batch.id,
            documentId: document.id,
            rowIndex: 2,
            normalizedMonth: "2024年6月",
            code: "",
            name: "合计",
            unit: "",
            qty: 1,
            price: 1,
            amount: 1,
            status: "confirmed",
          },
        ],
      });

      const rebuild = await rebuildProductLibrary({}, tx);
      const products = await tx.product.findMany({ include: { conflicts: true } });
      const recognitionWorkbook = await readWorkbook(await buildRecognitionExport(undefined, undefined, tx));
      const productWorkbook = await readWorkbook(await buildProductExport(tx));

      assert.equal(rebuild.products, 2);
      assert.equal(rebuild.conflicts, 1);
      assert.equal(
        products.some((product) => product.name === "合计" && product.conflicts.length === 1),
        true,
      );
      assert.equal(recognitionWorkbook.getWorksheet("识别结果")?.rowCount, 3);
      assert.equal(productWorkbook.getWorksheet("副食品资料库")?.rowCount, 3);

      // 选择性导出（M2）：scope 下推 where，按 name 过滤只导出匹配行
      const scopedByName = await readWorkbook(await buildRecognitionExport(undefined, { name: "苹果" }, tx));
      assert.equal(scopedByName.getWorksheet("识别结果")?.rowCount, 2); // 表头 + 苹果 1 行
      // 不存在的 batchId → 空结果（仅表头）
      const scopedEmpty = await readWorkbook(
        await buildRecognitionExport(undefined, { batchId: "nonexistent" }, tx),
      );
      assert.equal(scopedEmpty.getWorksheet("识别结果")?.rowCount, 1);
    });
  });

  it("marks same-name products with different codes as product conflicts", async () => {
    await withRollback(async (tx) => {
      const batch = await tx.batch.create({ data: { name: "multi-code-product-test" } });
      const name = "__测试同名多码商品__";
      const document = await tx.document.create({
        data: {
          batchId: batch.id,
          originalName: "multi-code.jpg",
          storedPath: "",
          hash: "multi-code-hash",
          mimeType: "image/jpeg",
          sizeBytes: 0,
        },
      });
      await tx.recognitionRow.createMany({
        data: [
          {
            batchId: batch.id,
            documentId: document.id,
            rowIndex: 1,
            code: "B2001",
            name,
            unit: "斤",
            qty: 1,
            price: 2,
            amount: 2,
            status: "confirmed",
          },
          {
            batchId: batch.id,
            documentId: document.id,
            rowIndex: 2,
            code: "B2002",
            name,
            unit: "斤",
            qty: 1,
            price: 3,
            amount: 3,
            status: "confirmed",
          },
        ],
      });

      await rebuildProductLibrary({}, tx);
      const products = await tx.product.findMany({ where: { name }, include: { conflicts: true } });
      const conflicts = products.flatMap((product) =>
        product.conflicts.filter((conflict) => conflict.type === "NAME_MULTI_CODE"),
      );

      assert.equal(products.length, 2);
      assert.equal(conflicts.length, 2);
      assert.equal(
        conflicts.every((conflict) => conflict.reason.includes("B2001") && conflict.reason.includes("B2002")),
        true,
      );
    });
  });

  it("marks same-code products with different names as separate product conflicts", async () => {
    await withRollback(async (tx) => {
      const batch = await tx.batch.create({ data: { name: "multi-product-code-test" } });
      const code = "D1001";
      const document = await tx.document.create({
        data: {
          batchId: batch.id,
          originalName: "multi-product-code.jpg",
          storedPath: "",
          hash: "multi-product-code-hash",
          mimeType: "image/jpeg",
          sizeBytes: 0,
        },
      });
      await tx.recognitionRow.createMany({
        data: [
          {
            batchId: batch.id,
            documentId: document.id,
            rowIndex: 1,
            code,
            name: "__测试同码商品A__",
            unit: "斤",
            qty: 1,
            price: 2,
            amount: 2,
            status: "confirmed",
          },
          {
            batchId: batch.id,
            documentId: document.id,
            rowIndex: 2,
            code,
            name: "__测试同码商品B__",
            unit: "斤",
            qty: 1,
            price: 3,
            amount: 3,
            status: "confirmed",
          },
        ],
      });

      await rebuildProductLibrary({}, tx);
      const products = await tx.product.findMany({ where: { code }, include: { conflicts: true } });
      const codeConflicts = products.flatMap((product) =>
        product.conflicts.filter((conflict) => conflict.type === "CODE_NAME_CONFLICT"),
      );
      const nameConflicts = products.flatMap((product) =>
        product.conflicts.filter((conflict) => conflict.type === "NAME_MULTI_CODE"),
      );

      assert.equal(products.length, 2);
      assert.equal(codeConflicts.length, 2);
      assert.equal(nameConflicts.length, 0);
      assert.equal(
        codeConflicts.every(
          (conflict) =>
            conflict.reason.includes("__测试同码商品A__") && conflict.reason.includes("__测试同码商品B__"),
        ),
        true,
      );
    });
  });

  it("preserves ignored product conflicts across product library rebuilds", async () => {
    await withRollback(async (tx) => {
      const batch = await tx.batch.create({ data: { name: "preserve-conflict-resolution-test" } });
      const name = "__测试保留忽略状态商品__";
      const document = await tx.document.create({
        data: {
          batchId: batch.id,
          originalName: "preserve-conflict.jpg",
          storedPath: "",
          hash: "preserve-conflict-hash",
          mimeType: "image/jpeg",
          sizeBytes: 0,
        },
      });
      await tx.recognitionRow.createMany({
        data: [
          {
            batchId: batch.id,
            documentId: document.id,
            rowIndex: 1,
            code: "C1001",
            name,
            unit: "斤",
            qty: 1,
            price: 2,
            amount: 2,
            status: "confirmed",
          },
          {
            batchId: batch.id,
            documentId: document.id,
            rowIndex: 2,
            code: "C1002",
            name,
            unit: "斤",
            qty: 1,
            price: 3,
            amount: 3,
            status: "confirmed",
          },
        ],
      });

      await rebuildProductLibrary({}, tx);
      const initialConflicts = (
        await tx.productConflict.findMany({ where: { type: "NAME_MULTI_CODE" }, include: { product: true } })
      ).filter((conflict) => conflict.product?.name === name);
      const ignoredTarget = initialConflicts.find((conflict) => conflict.product?.code === "C1001");
      assert.ok(ignoredTarget);
      await resolveProductConflict(ignoredTarget.id, { status: "ignored" }, tx);

      await rebuildProductLibrary({}, tx);
      const rebuiltConflicts = (
        await tx.productConflict.findMany({ where: { type: "NAME_MULTI_CODE" }, include: { product: true } })
      ).filter((conflict) => conflict.product?.name === name);
      const preserved = rebuiltConflicts.find((conflict) => conflict.product?.code === "C1001");
      const stillOpen = rebuiltConflicts.find((conflict) => conflict.product?.code === "C1002");

      assert.equal(preserved?.status, "ignored");
      assert.ok(preserved?.resolvedAt);
      assert.equal(stillOpen?.status, "open");
    });
  });

  it("批次绑定导出模板并派生抽取场景（M3a）", async () => {
    await withRollback(async (tx) => {
      const template = getExportTemplate("purchase-stats-20260619");
      assert.equal(template.scenarioId, "grocery");
      // 模拟创建逻辑：绑定模板 + 场景由模板派生
      const batch = await tx.batch.create({
        data: { name: "bind", exportTemplateId: template.id, scenarioId: template.scenarioId },
      });
      const read = await tx.batch.findUniqueOrThrow({ where: { id: batch.id } });
      assert.equal(read.exportTemplateId, "purchase-stats-20260619");
      assert.equal(read.scenarioId, "grocery");
    });
  });

  it("追加导出把新数据并入上传基准（M4，pivot 重渲染）", async () => {
    await withRollback(async (tx) => {
      const batch = await tx.batch.create({ data: { name: "append-test" } });
      const doc = await tx.document.create({
        data: {
          batchId: batch.id,
          originalName: "a.jpg",
          storedPath: "",
          hash: "ah",
          mimeType: "image/jpeg",
          sizeBytes: 0,
        },
      });
      await tx.recognitionRow.create({
        data: {
          batchId: batch.id,
          documentId: doc.id,
          rowIndex: 1,
          normalizedMonth: "2020年1月",
          code: "100001",
          name: "土豆",
          unit: "斤",
          qty: 20,
          price: 4,
          amount: 80,
          status: "confirmed",
        },
      });
      // 基准文件：当前只有 1 行时先导出一份 pivot
      const baseBuffer = await buildRecognitionExport("purchase-stats-20260619", { batchId: batch.id }, tx);
      // 再新增一行（不同月份）
      await tx.recognitionRow.create({
        data: {
          batchId: batch.id,
          documentId: doc.id,
          rowIndex: 2,
          normalizedMonth: "2019年12月",
          code: "100001",
          name: "土豆",
          unit: "斤",
          qty: 30,
          price: 6,
          amount: 180,
          status: "confirmed",
        },
      });
      // 追加：把本批次（2 行）并入基准（含 1 行还原）→ 土豆 sheet 共 3 条数据行 + 月份并集
      const { buffer, newRowCount } = await appendRecognitionExport(
        "purchase-stats-20260619",
        { batchId: batch.id },
        baseBuffer,
        tx,
      );
      assert.equal(newRowCount, 2);
      const out = new ExcelJS.Workbook();
      await out.xlsx.load(buffer as unknown as Parameters<typeof out.xlsx.load>[0]);
      const sheet = out.getWorksheet("100001土豆")!;
      assert.equal(sheet.rowCount, 5); // 标题 + 表头 + 3 数据行
      // 表头含两个月份列（并集）
      const headers = [3, 4].map((c) => sheet.getRow(2).getCell(c).value);
      assert.deepEqual(headers, ["2020年1月", "2019年12月"]);
    });
  });

  it("confirms only selected rows by rowIds and rejects empty selector", async () => {
    await withRollback(async (tx) => {
      const batch = await tx.batch.create({ data: { name: "confirm-rowids" } });
      const document = await tx.document.create({
        data: {
          batchId: batch.id,
          originalName: "confirm.jpg",
          storedPath: "",
          hash: "confirm-hash",
          mimeType: "image/jpeg",
          sizeBytes: 0,
        },
      });
      const high = await tx.recognitionRow.create({
        data: {
          batchId: batch.id,
          documentId: document.id,
          rowIndex: 1,
          name: "苹果",
          riskLevel: "high",
          status: "pending",
        },
      });
      const low = await tx.recognitionRow.create({
        data: {
          batchId: batch.id,
          documentId: document.id,
          rowIndex: 2,
          name: "香蕉",
          riskLevel: "low",
          status: "pending",
        },
      });

      // 空选择器不得确认任何行。
      assert.equal(await confirmRecognitionRows({}, tx), null);

      // rowIds 精确确认所选行（即使是高风险）。
      assert.equal(await confirmRecognitionRows({ rowIds: [high.id] }, tx), 1);

      const rows = await tx.recognitionRow.findMany({
        where: { batchId: batch.id },
        orderBy: { rowIndex: "asc" },
      });
      assert.equal(rows[0].status, "confirmed");
      assert.equal(rows[0].id, high.id);
      assert.equal(rows[1].status, "pending");
      assert.equal(rows[1].id, low.id);
    });
  });

  it("confirms whole document, and batch selector defaults to low-risk only", async () => {
    await withRollback(async (tx) => {
      const batch = await tx.batch.create({ data: { name: "confirm-scope" } });
      const document = await tx.document.create({
        data: {
          batchId: batch.id,
          originalName: "scope.jpg",
          storedPath: "",
          hash: "scope-hash",
          mimeType: "image/jpeg",
          sizeBytes: 0,
        },
      });
      await tx.recognitionRow.createMany({
        data: [
          {
            batchId: batch.id,
            documentId: document.id,
            rowIndex: 1,
            name: "苹果",
            riskLevel: "high",
            status: "pending",
          },
          {
            batchId: batch.id,
            documentId: document.id,
            rowIndex: 2,
            name: "香蕉",
            riskLevel: "low",
            status: "pending",
          },
        ],
      });

      // batchId 默认仅低风险 → 只确认 1 行。
      assert.equal(await confirmRecognitionRows({ batchId: batch.id }, tx), 1);
      const afterBatch = await tx.recognitionRow.findMany({
        where: { batchId: batch.id },
        orderBy: { rowIndex: "asc" },
      });
      assert.equal(afterBatch[0].status, "pending");
      assert.equal(afterBatch[1].status, "confirmed");

      // documentId 确认整单（含高风险）。
      assert.equal(await confirmRecognitionRows({ documentId: document.id }, tx), 2);
      const afterDoc = await tx.recognitionRow.findMany({ where: { batchId: batch.id } });
      assert.equal(
        afterDoc.every((row) => row.status === "confirmed"),
        true,
      );
    });
  });

  it("clears only short product codes within the selected document", async () => {
    await withRollback(async (tx) => {
      const batch = await tx.batch.create({ data: { name: "clear-short-codes" } });
      const document = await tx.document.create({
        data: {
          batchId: batch.id,
          originalName: "short-code.jpg",
          storedPath: "",
          hash: "short-code-hash",
          mimeType: "image/jpeg",
          sizeBytes: 0,
        },
      });
      await tx.recognitionRow.createMany({
        data: [
          {
            batchId: batch.id,
            documentId: document.id,
            rowIndex: 1,
            code: "1",
            name: "苹果",
            qty: 1,
            price: 2,
            amount: 2,
          },
          {
            batchId: batch.id,
            documentId: document.id,
            rowIndex: 2,
            code: "A2",
            name: "香蕉",
            qty: 1,
            price: 3,
            amount: 3,
          },
          {
            batchId: batch.id,
            documentId: document.id,
            rowIndex: 3,
            code: "123",
            name: "橙子",
            qty: 1,
            price: 4,
            amount: 4,
          },
          {
            batchId: batch.id,
            documentId: document.id,
            rowIndex: 4,
            code: "",
            name: "葡萄",
            qty: 1,
            price: 5,
            amount: 5,
          },
        ],
      });

      const result = await clearShortProductCodes({ documentId: document.id }, tx);
      const rows = await tx.recognitionRow.findMany({
        where: { documentId: document.id },
        orderBy: { rowIndex: "asc" },
      });
      const auditCount = await tx.auditLog.count({
        where: {
          entityType: "RecognitionRow",
          action: "update",
          entityId: { in: rows.map((row) => row.id) },
        },
      });

      assert.deepEqual(result, { matched: 2, updated: 2 });
      assert.deepEqual(
        rows.map((row) => row.code),
        ["", "", "123", ""],
      );
      assert.equal(auditCount, 2);
    });
  });

  it("resolves a product conflict and returns null for a missing one", async () => {
    await withRollback(async (tx) => {
      const product = await tx.product.create({ data: { name: "合计" } });
      const conflict = await tx.productConflict.create({
        data: {
          productId: product.id,
          type: "INVALID_PRODUCT_NAME",
          severity: "high",
          reason: "疑似非商品名",
        },
      });

      const resolved = await resolveProductConflict(conflict.id, { status: "resolved" }, tx);
      assert.equal(resolved?.status, "resolved");
      assert.ok(resolved?.resolvedAt);

      assert.equal(await resolveProductConflict("does-not-exist", {}, tx), null);
    });
  });

  it("bulk replaces product code/name within the selected conflict rows", async () => {
    await withRollback(async (tx) => {
      const batch = await tx.batch.create({ data: { name: "replace-conflict-test" } });
      const document = await tx.document.create({
        data: {
          batchId: batch.id,
          originalName: "replace-conflict.jpg",
          storedPath: "",
          hash: "replace-conflict-hash",
          mimeType: "image/jpeg",
          sizeBytes: 0,
        },
      });
      await tx.recognitionRow.createMany({
        data: [
          {
            batchId: batch.id,
            documentId: document.id,
            rowIndex: 1,
            code: "R100",
            name: "苹果",
            qty: 1,
            price: 2,
            amount: 2,
          },
          {
            batchId: batch.id,
            documentId: document.id,
            rowIndex: 2,
            code: "R101",
            name: "苹果",
            qty: 1,
            price: 2,
            amount: 2,
          },
          {
            batchId: batch.id,
            documentId: document.id,
            rowIndex: 3,
            code: "R200",
            name: "香蕉",
            qty: 1,
            price: 3,
            amount: 3,
          },
          {
            batchId: batch.id,
            documentId: document.id,
            rowIndex: 4,
            code: "R200",
            name: "蕉香",
            qty: 1,
            price: 3,
            amount: 3,
          },
          {
            batchId: batch.id,
            documentId: document.id,
            rowIndex: 5,
            code: "R200",
            name: "蕉香",
            qty: 1,
            price: 3,
            amount: 3,
          },
        ],
      });
      const rows = await tx.recognitionRow.findMany({
        where: { documentId: document.id },
        orderBy: { rowIndex: "asc" },
      });

      const codeResult = await replaceProductCodesByName(
        { name: "苹果", toCode: "R100", rowIds: [rows[0].id, rows[1].id] },
        tx,
      );
      const nameResult = await replaceProductNamesByCode(
        { code: "R200", toName: "蕉香", rowIds: [rows[2].id, rows[3].id, rows[4].id] },
        tx,
      );
      const updated = await tx.recognitionRow.findMany({
        where: { documentId: document.id },
        orderBy: { rowIndex: "asc" },
      });
      const auditCount = await tx.auditLog.count({
        where: {
          entityType: "RecognitionRow",
          action: "update",
          entityId: { in: rows.map((row) => row.id) },
        },
      });

      assert.equal(codeResult?.matched, 2);
      assert.equal(codeResult?.updated, 1);
      assert.equal(nameResult?.matched, 3);
      assert.equal(nameResult?.updated, 1);
      assert.deepEqual(
        updated.map((row) => [row.code, row.name]),
        [
          ["R100", "苹果"],
          ["R100", "苹果"],
          ["R200", "蕉香"],
          ["R200", "蕉香"],
          ["R200", "蕉香"],
        ],
      );
      assert.equal(auditCount, 2);
    });
  });
});

describe("review decisions", () => {
  it("never auto-approves high risk; mode gates the rest", () => {
    // 高风险任何模式都转冲突。
    assert.deepEqual(decideRowReview("auto", "high", true), { status: "conflict", reviewClass: "conflict" });
    assert.deepEqual(decideRowReview("hybrid", "high", true), {
      status: "conflict",
      reviewClass: "conflict",
    });

    // manual：不自动通过。
    assert.equal(decideRowReview("manual", "low", true).reviewClass, "pending_review");

    // hybrid：低风险 + 双次一致 → 自动通过；缺一不可。
    assert.equal(decideRowReview("hybrid", "low", true).reviewClass, "ai_auto");
    assert.equal(decideRowReview("hybrid", "low", false).reviewClass, "pending_review");
    assert.equal(decideRowReview("hybrid", "medium", true).reviewClass, "pending_review");

    // auto：双次一致即自动通过（含中风险）；不一致转人工。
    assert.equal(decideRowReview("auto", "medium", true).reviewClass, "ai_auto");
    assert.equal(decideRowReview("auto", "low", false).reviewClass, "pending_review");
  });

  it("consensus flags match rows by code/name within tolerance", () => {
    const a = [
      { code: "A1", name: "苹果", qty: 2, price: 3, amount: 6 },
      { code: "", name: "香蕉", qty: 5, price: 6, amount: 30 },
      { code: "", name: "牛奶", qty: 1, price: 9, amount: 9 },
    ];
    const b = [
      { code: "A1", name: "苹果", qty: 2, price: 3, amount: 6 }, // 按编码匹配
      { code: "", name: "香 蕉", qty: 5, price: 6, amount: 30 }, // 按去空白名称匹配
      { code: "", name: "牛奶", qty: 1, price: 8, amount: 8 }, // 单价/金额不一致 → 不匹配
    ];
    assert.deepEqual(buildConsensusFlags(a, b), [true, true, false]);
  });

  it("recognition strategy controls whether consensus is actually run", () => {
    assert.equal(shouldRunConsensus("fast", "auto", true), false);
    assert.equal(shouldRunConsensus("manual", "auto", true), false);
    assert.equal(shouldRunConsensus("balanced", "hybrid", false), false);
    assert.equal(shouldRunConsensus("balanced", "hybrid", true), true);
    assert.equal(shouldRunConsensus("consensus", "hybrid", false), true);
    assert.equal(shouldRunConsensus("consensus", "manual", true), false);
  });
});

describe("provider prompts", () => {
  it("prefers provider override, then global default, then built-in", () => {
    // provider 覆盖优先。
    assert.deepEqual(
      resolveProviderPrompts(
        { systemPrompt: "S-OVR", userPrompt: "U-OVR" },
        { systemPrompt: "S-G", userPrompt: "U-G" },
      ),
      { systemPrompt: "S-OVR", userPrompt: "U-OVR" },
    );
    // provider 空白/为空 → 回退全局默认。
    assert.deepEqual(
      resolveProviderPrompts(
        { systemPrompt: "   ", userPrompt: null },
        { systemPrompt: "S-G", userPrompt: "U-G" },
      ),
      { systemPrompt: "S-G", userPrompt: "U-G" },
    );
    // provider 与全局都空 → 内置默认。
    assert.deepEqual(resolveProviderPrompts({}, {}), {
      systemPrompt: defaultRecognitionPrompts.systemPrompt,
      userPrompt: defaultRecognitionPrompts.userPrompt,
    });
    // worker 在全局提示词仍为内置默认时不传 defaults，让非默认场景 fallback 生效。
    assert.deepEqual(
      resolveProviderPrompts({}, undefined, { systemPrompt: "S-SCENE", userPrompt: "U-SCENE" }),
      {
        systemPrompt: "S-SCENE",
        userPrompt: "U-SCENE",
      },
    );
  });
});

describe("source region prompt injection", () => {
  // 回归：用户/历史在设置页保存的自定义提示词不含坐标指令时，原图映射会整体失效。
  // 解法是在构造 provider 时强制幂等补回 sourceRegion 指令，而不污染 resolveProviderPrompts 的纯优先级语义。
  it("内置默认提示词已含 sourceRegion 指令 → 幂等不重复注入", () => {
    assert.ok(defaultRecognitionPrompts.systemPrompt.includes("sourceRegion"));
    assert.equal(
      ensureSourceRegionInstruction(defaultRecognitionPrompts.systemPrompt),
      defaultRecognitionPrompts.systemPrompt,
    );
  });

  it("自定义提示词缺失指令时补回坐标要求（复现线上已保存的全局提示词）", () => {
    const stored = "【全局】识别副食品销售单，结构化输出";
    const injected = ensureSourceRegionInstruction(stored);
    assert.ok(injected.startsWith(stored));
    assert.ok(injected.includes(sourceRegionPromptInstruction));
    assert.ok(injected.includes("sourceRegion"));
  });
});

describe("audit rules", () => {
  const history = [
    { name: "苹果", code: "", unit: "斤", qty: 1, price: 5, amount: 5 },
    { name: "苹果", code: "", unit: "斤", qty: 1, price: 5.2, amount: 5.2 },
    { name: "苹果", code: "", unit: "斤", qty: 1, price: 4.8, amount: 4.8 },
  ];

  it("flags price outliers and unit mismatches vs history; clean rows pass", () => {
    const stats = buildAuditStats(history);
    // 正常价/单位 → 不可疑。
    assert.equal(
      auditRowByRules({ name: "苹果", code: "", unit: "斤", qty: 1, price: 5, amount: 5 }, stats).suspicious,
      false,
    );
    // 单价远离历史中位数 → PRICE_OUTLIER。
    const outlier = auditRowByRules(
      { name: "苹果", code: "", unit: "斤", qty: 1, price: 50, amount: 50 },
      stats,
    );
    assert.equal(outlier.suspicious, true);
    assert.ok(outlier.reasons.includes("PRICE_OUTLIER"));
    // 单位与历史主导不一致 → UNIT_MISMATCH。
    const unit = auditRowByRules({ name: "苹果", code: "", unit: "箱", qty: 1, price: 5, amount: 5 }, stats);
    assert.ok(unit.reasons.includes("UNIT_MISMATCH"));
  });

  it("flags rule violations (invalid name / amount mismatch)", () => {
    const bad = auditRowByRules(
      { name: "合计", code: "", unit: "", qty: 1, price: 2, amount: 99 },
      buildAuditStats([]),
    );
    assert.equal(bad.suspicious, true);
    assert.ok(bad.reasons.includes("RULE_VIOLATION"));
  });

  it("detects duplicate rows within a document", () => {
    const dups = findDuplicateRowIds([
      { id: "a", name: "苹果", code: "", unit: "斤", qty: 1, price: 5, amount: 5 },
      { id: "b", name: "苹果", code: "", unit: "斤", qty: 1, price: 5, amount: 5 },
      { id: "c", name: "香蕉", code: "", unit: "斤", qty: 2, price: 3, amount: 6 },
    ]);
    assert.deepEqual([dups.has("a"), dups.has("b"), dups.has("c")], [true, true, false]);
  });
});
