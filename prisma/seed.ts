import "dotenv/config";

import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { prisma } from "../src/lib/db/client";
import { env } from "../src/lib/env";
import { ensureRuleCatalogSeeded } from "../src/lib/rules/catalog";

type DemoRow = {
  rowIndex: number;
  rawDate: string | null;
  normalizedMonth: string | null;
  code: string | null;
  name: string;
  unit: string | null;
  qty: number;
  price: number;
  amount: number;
  remark: string | null;
  status: string;
  reviewClass: string;
  riskLevel: string;
  riskReasonsJson: string;
  conflictState: string;
  auditState: string;
  auditNote: string | null;
  sourceRegionJson: string | null;
};

type DemoSample = {
  id: string;
  asset: string;
  originalName: string;
  sourceType: string;
  sourceFile: string;
  pageNumber: number | null;
  pageCount: number | null;
  rows: DemoRow[];
};

type SeededDemoRow = {
  id: string;
  documentId: string;
  rowIndex: number;
  row: DemoRow;
};

async function loadDemoSamples(): Promise<DemoSample[]> {
  const filePath = path.join(process.cwd(), "demo-samples.json");
  const parsed = JSON.parse(await readFile(filePath, "utf-8")) as { samples?: DemoSample[] };
  if (!parsed.samples || parsed.samples.length !== 10) {
    throw new Error("Expected exactly 10 sanitized public OCR demo samples.");
  }
  return parsed.samples;
}

async function stageDemoImage(sample: DemoSample): Promise<{ storedPath: string; sizeBytes: number }> {
  const sourcePath = path.join(process.cwd(), "public", "demo-documents", sample.asset);
  const dir = path.join(env.storageDir, "originals", "demo-public-set");
  await mkdir(dir, { recursive: true });
  const storedPath = path.join(dir, sample.asset);
  await copyFile(sourcePath, storedPath);
  return { storedPath, sizeBytes: (await stat(storedPath)).size };
}

async function main() {
  await prisma.productConflict.deleteMany();
  await prisma.product.deleteMany();
  await prisma.productObservation.deleteMany();
  await prisma.recognitionRow.deleteMany();
  await prisma.extractionAttempt.deleteMany();
  await prisma.recognitionJob.deleteMany();
  await prisma.document.deleteMany();
  await prisma.batch.deleteMany();
  await prisma.aiProviderModel.deleteMany();
  await prisma.aiProviderConfig.deleteMany();
  await prisma.appSetting.deleteMany();

  const providers = await Promise.all(
    [
      {
        providerKey: "openai-responses-default",
        displayName: "OpenAI Responses",
        protocol: "openai_responses",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "",
        enabled: false,
        priority: 10,
        maxOutputTokens: 2000,
        metadataJson: JSON.stringify({ notes: "在设置页填入 API Key 后启用" }),
        models: [
          { modelId: "gpt-4.1", displayName: "GPT-4.1", priority: 10 },
          { modelId: "gpt-4.1-mini", displayName: "GPT-4.1 mini", priority: 20 },
        ],
      },
      {
        providerKey: "anthropic-default",
        displayName: "Anthropic Messages",
        protocol: "anthropic_messages",
        baseUrl: "https://api.anthropic.com",
        apiKey: "",
        enabled: false,
        priority: 20,
        maxOutputTokens: 2000,
        metadataJson: JSON.stringify({ notes: "在设置页填入 API Key 后启用" }),
        models: [
          { modelId: "claude-opus-4-8", displayName: "Claude Opus 4.8", priority: 10 },
          { modelId: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6", priority: 20 },
          { modelId: "claude-haiku-4-5", displayName: "Claude Haiku 4.5", priority: 30 },
        ],
      },
    ].map(({ models, ...provider }) =>
      prisma.aiProviderConfig.create({
        data: {
          ...provider,
          models: {
            create: models.map((model) => ({
              ...model,
              enabled: true,
              source: "manual",
              metadataJson: "{}",
            })),
          },
        },
      }),
    ),
  );

  await prisma.appSetting.create({
    data: {
      key: "recognition.defaults",
      valueJson: JSON.stringify({
        strategy: "balanced",
        amountTolerance: 0.01,
        queueConcurrency: 3,
        maxAttempts: 3,
        backoffSeconds: 30,
        primaryProviderKey: providers[0].providerKey,
        primaryModelId: "gpt-4.1",
        secondaryProviderKey: providers[0].providerKey,
        secondaryModelId: "gpt-4.1-mini",
      }),
    },
  });

  const samples = await loadDemoSamples();
  const batch = await prisma.batch.create({
    data: {
      id: "demo-public-set",
      name: "Public OCR Demo | 10 redacted samples",
      status: "completed",
      strategy: "balanced",
      notes:
        "Anonymized public demo data. Images show complete item-table crops; personal identifiers, signatures, stamps, and unrelated header fields are omitted. This showcase includes illustrative AI auto-approval, human review, risk flags, processing timing, and recognition-attempt records.",
    },
  });

  const productMap = new Map<
    string,
    { code: string | null; name: string; unit: string | null; price: number | null }
  >();
  const riskRank = { low: 0, medium: 1, high: 2 } as const;
  const seededRows: SeededDemoRow[] = [];
  const reviewBase = new Date("2026-07-13T08:00:00.000Z");

  for (const sample of samples) {
    const image = await stageDemoImage(sample);
    const riskLevel = sample.rows.reduce<"low" | "medium" | "high">(
      (highest, row) =>
        (riskRank[row.riskLevel as keyof typeof riskRank] ?? 0) > riskRank[highest]
          ? (row.riskLevel as "low" | "medium" | "high")
          : highest,
      "low",
    );
    await prisma.document.create({
      data: {
        id: sample.id,
        batchId: batch.id,
        originalName: sample.originalName,
        storedPath: image.storedPath,
        hash: `demo-hash-${sample.id}`,
        mimeType: "image/jpeg",
        sizeBytes: image.sizeBytes,
        status: "extracted",
        reviewStatus: "pending",
        riskLevel,
        sourceType: sample.sourceType,
        sourceFile: sample.sourceFile,
        pageNumber: sample.pageNumber,
        pageCount: sample.pageCount,
      },
    });

    for (const row of sample.rows) {
      const rowId = `${sample.id}-row-${String(row.rowIndex).padStart(3, "0")}`;
      await prisma.recognitionRow.create({
        data: {
          id: rowId,
          batchId: batch.id,
          documentId: sample.id,
          rowIndex: row.rowIndex,
          rawDate: row.rawDate,
          normalizedMonth: row.normalizedMonth,
          code: row.code,
          name: row.name,
          unit: row.unit,
          qty: row.qty,
          price: row.price,
          amount: row.amount,
          remark: row.remark,
          status: row.status,
          reviewClass: row.reviewClass,
          riskLevel: row.riskLevel,
          riskReasonsJson: row.riskReasonsJson,
          conflictState: row.conflictState,
          auditState: row.auditState,
          auditNote: row.auditNote,
          sourceRegionJson: null,
        },
      });

      const productKey = `${row.code ?? ""}|${row.name}|${row.unit ?? ""}`;
      if (!productMap.has(productKey)) {
        productMap.set(productKey, {
          code: row.code,
          name: row.name,
          unit: row.unit,
          price: row.price || null,
        });
      }
      seededRows.push({ id: rowId, documentId: sample.id, rowIndex: row.rowIndex, row });
    }
  }

  // The public showcase deliberately contains a small mix of AI-approved rows,
  // human-confirmed rows, and review cases so the dashboard reflects the hybrid workflow.
  const conflictSpecs = [
    {
      type: "NAME_MULTI_CODE",
      severity: "medium",
      reason: "同一商品名对应多个编码：400032、300536",
      productCode: "400032",
      productName: "鱿鱼",
      sourceRowIds: ["demo-doc-03-row-019", "demo-doc-03-row-029", "demo-doc-10-row-024"],
    },
    {
      type: "NAME_MULTI_CODE",
      severity: "medium",
      reason: "同一商品名对应多个编码：100134、100061",
      productCode: "100134",
      productName: "千页豆腐",
      sourceRowIds: ["demo-doc-06-row-019", "demo-doc-10-row-023"],
    },
    {
      type: "CODE_NAME_CONFLICT",
      severity: "high",
      reason: "同一编码对应多个商品：鱿鱼、雨润一级精品肉片",
      productCode: "300536",
      productName: "鱿鱼",
      sourceRowIds: ["demo-doc-03-row-029", "demo-doc-08-row-023"],
    },
  ] as const;
  const conflictReasonByRowId = new Map<string, string[]>();
  for (const conflict of conflictSpecs) {
    for (const rowId of conflict.sourceRowIds) {
      conflictReasonByRowId.set(rowId, [
        ...(conflictReasonByRowId.get(rowId) ?? []),
        conflict.type,
      ]);
    }
  }

  const manualReviewDocumentIds = new Set(["demo-doc-02", "demo-doc-03", "demo-doc-05", "demo-doc-08", "demo-doc-10"]);
  const pendingRowIds = new Set(
    seededRows
      .filter((row) => manualReviewDocumentIds.has(row.documentId) && row.rowIndex % 7 === 0)
      .map((row) => row.id),
  );
  for (const rowId of conflictReasonByRowId.keys()) pendingRowIds.add(rowId);
  const flaggedRowIds = new Set(
    seededRows
      .filter((row) => row.rowIndex % 11 === 0)
      .slice(0, 8)
      .map((row) => row.id),
  );
  const documentRisk = new Map<string, "low" | "medium" | "high">();
  const documentReasons = new Map<string, Set<string>>();
  const documentHasPending = new Set<string>();

  for (const seededRow of seededRows) {
    const conflictReasons = conflictReasonByRowId.get(seededRow.id) ?? [];
    const isConflict = conflictReasons.includes("CODE_NAME_CONFLICT") || conflictReasons.includes("NAME_MULTI_CODE");
    const isPending = pendingRowIds.has(seededRow.id);
    const isFlagged = flaggedRowIds.has(seededRow.id);
    const isHumanConfirmed = !isPending && (isFlagged || seededRow.rowIndex % 5 === 0);
    const status = isConflict ? "conflict" : isPending ? "needs_review" : "confirmed";
    const reviewClass = isConflict
      ? "conflict"
      : isPending
        ? "pending_review"
        : isHumanConfirmed
          ? "human"
          : "ai_auto";
    const riskLevel = isConflict ? "high" : isPending || isFlagged ? "medium" : "low";
    const riskReasons = conflictReasons.length
      ? conflictReasons
      : isPending
        ? seededRow.rowIndex % 2 === 0
          ? ["AMOUNT_MISMATCH"]
          : ["PRICE_OUTLIER"]
        : isFlagged
          ? ["PRICE_OUTLIER"]
          : [];
    const demoAmountMismatch = riskReasons.includes("AMOUNT_MISMATCH")
      ? Number((seededRow.row.amount + Math.max(0.5, seededRow.row.price * 0.02)).toFixed(2))
      : seededRow.row.amount;

    await prisma.recognitionRow.update({
      where: { id: seededRow.id },
      data: {
        amount: demoAmountMismatch,
        status,
        reviewClass,
        riskLevel,
        riskReasonsJson: JSON.stringify(riskReasons),
        conflictState: riskReasons.length ? "open" : "none",
        auditState: isFlagged ? "flagged" : "none",
        auditNote: isFlagged ? "演示：历史单价偏离，建议人工核对" : null,
      },
    });

    if (isPending) documentHasPending.add(seededRow.documentId);
    const reasonsForDocument = documentReasons.get(seededRow.documentId) ?? new Set<string>();
    for (const reason of riskReasons) reasonsForDocument.add(reason);
    documentReasons.set(seededRow.documentId, reasonsForDocument);
    const currentRisk = documentRisk.get(seededRow.documentId) ?? "low";
    if (riskRank[riskLevel as keyof typeof riskRank] > riskRank[currentRisk]) {
      documentRisk.set(seededRow.documentId, riskLevel);
    }
  }

  for (const [sampleIndex, sample] of samples.entries()) {
    const hasPending = documentHasPending.has(sample.id);
    const start = new Date(reviewBase.getTime() + sampleIndex * 45 * 60 * 1000);
    const durationMs = (sampleIndex % 3 === 0 ? 2 : sampleIndex % 3 === 1 ? 3 : 4) * 60 * 1000 + 30 * 1000;
    await prisma.document.update({
      where: { id: sample.id },
      data: {
        status: "extracted",
        reviewStatus: hasPending ? "pending" : "reviewed",
        riskLevel: documentRisk.get(sample.id) ?? "low",
        riskReasonsJson: JSON.stringify([... (documentReasons.get(sample.id) ?? new Set<string>())]),
        reviewStartedAt: start,
        reviewCompletedAt: hasPending ? null : new Date(start.getTime() + durationMs),
      },
    });
  }
  await prisma.batch.update({
    where: { id: batch.id },
    data: { status: pendingRowIds.size ? "needs_review" : "completed" },
  });

  await prisma.product.createMany({
    data: Array.from(productMap.values()).map((product) => ({ ...product, status: "active" })),
  });

  for (const conflict of conflictSpecs) {
    const product = await prisma.product.findFirst({
      where: { code: conflict.productCode, name: conflict.productName },
      select: { id: true },
    });
    await prisma.productConflict.create({
      data: {
        productId: product?.id,
        type: conflict.type,
        severity: conflict.severity,
        reason: conflict.reason,
        sourceRowIdsJson: JSON.stringify(conflict.sourceRowIds),
        status: "open",
      },
    });
  }

  // Keep completed AI attempts visible in the public Review Center without calling any provider.
  // They document the intended two-pass consensus workflow used by the live application.
  for (const [sampleIndex, sample] of samples.entries()) {
    const attemptStart = new Date(reviewBase.getTime() + sampleIndex * 45 * 60 * 1000 - 30 * 1000);
    const job = await prisma.recognitionJob.create({
      data: {
        id: `${sample.id}-job`,
        batchId: batch.id,
        documentId: sample.id,
        type: "extract",
        status: "completed",
        attemptsMade: 1,
        maxAttempts: 3,
        nextRunAt: attemptStart,
      },
    });
    const parsedRows = sample.rows.map((row) => ({
      rawDate: row.rawDate,
      normalizedMonth: row.normalizedMonth,
      code: row.code,
      name: row.name,
      unit: row.unit,
      qty: row.qty,
      price: row.price,
      amount: row.amount,
      remark: row.remark,
    }));
    const primary = await prisma.extractionAttempt.create({
      data: {
        id: `${sample.id}-attempt-primary`,
        documentId: sample.id,
        jobId: job.id,
        providerKey: providers[0].providerKey,
        model: "gpt-4.1",
        promptVersion: "public-demo-v1",
        schemaVersion: "recognition-v1",
        strategy: "balanced",
        status: "completed",
        parsedJson: JSON.stringify({ rows: parsedRows }),
        validationJson: JSON.stringify({ pass: 1, consensus: "candidate", confidence: 0.94 }),
        tokenUsageJson: JSON.stringify({ input_tokens: 0, output_tokens: 0 }),
        costEstimate: 0,
        latencyMs: 1180 + sampleIndex * 63,
        startedAt: attemptStart,
        completedAt: new Date(attemptStart.getTime() + 1180 + sampleIndex * 63),
      },
    });
    await prisma.extractionAttempt.create({
      data: {
        id: `${sample.id}-attempt-secondary`,
        documentId: sample.id,
        jobId: job.id,
        providerKey: providers[0].providerKey,
        model: "gpt-4.1-mini",
        promptVersion: "public-demo-v1",
        schemaVersion: "recognition-v1",
        strategy: "balanced",
        status: "completed",
        parsedJson: JSON.stringify({ rows: parsedRows }),
        validationJson: JSON.stringify({ pass: 2, consensus: "matched", confidence: 0.92 }),
        tokenUsageJson: JSON.stringify({ input_tokens: 0, output_tokens: 0 }),
        costEstimate: 0,
        latencyMs: 940 + sampleIndex * 47,
        startedAt: new Date(attemptStart.getTime() + 250),
        completedAt: new Date(attemptStart.getTime() + 250 + 940 + sampleIndex * 47),
      },
    });
    await prisma.recognitionRow.updateMany({
      where: { documentId: sample.id },
      data: { canonicalAttemptId: primary.id },
    });
  }

  // 规则字典：补齐默认释义，确保新库开箱即可视化（不覆盖已有的运营编辑）。
  await ensureRuleCatalogSeeded(prisma);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
