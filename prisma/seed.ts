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
        "Anonymized public demo data. Images show complete item-table crops; personal identifiers, signatures, stamps, and unrelated header fields are omitted. Recognized product codes are retained for review.",
    },
  });

  const productMap = new Map<
    string,
    { code: string | null; name: string; unit: string | null; price: number | null }
  >();
  const riskRank = { low: 0, medium: 1, high: 2 } as const;

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
      await prisma.recognitionRow.create({
        data: {
          id: `${sample.id}-row-${String(row.rowIndex).padStart(3, "0")}`,
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
    }
  }

  await prisma.product.createMany({
    data: Array.from(productMap.values()).map((product) => ({ ...product, status: "active" })),
  });

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
