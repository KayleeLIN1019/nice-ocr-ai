import "dotenv/config";

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "../src/lib/db/client";
import { env } from "../src/lib/env";
import { ensureRuleCatalogSeeded } from "../src/lib/rules/catalog";

/** 生成一张 SVG 单据占位图，让审核台 / 批次详情的原图链路在种子数据下也能跑通。 */
async function writeSeedReceipt(): Promise<string> {
  const dir = path.join(env.storageDir, "originals", "seed");
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, "seed-doc-0123.svg");
  const lines = [
    ["A1001", "苹果", "10kg", "85.00"],
    ["A1002", "香蕉", "5kg", "30.00"],
    ["B2001", "牛奶", "2箱", "90.00"],
    ["", "合计", "", "205.00"],
  ];
  const rowSvg = lines
    .map(
      ([code, name, qty, amount], index) =>
        `<text x="24" y="${150 + index * 36}" font-size="18" fill="#1f2937">${code || "—"}　${name}　${qty}　¥${amount}</text>`,
    )
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="460" viewBox="0 0 360 460">
  <rect width="360" height="460" fill="#ffffff" stroke="#d1d5db"/>
  <text x="24" y="56" font-size="24" font-weight="bold" fill="#111827">销售单据样例</text>
  <text x="24" y="88" font-size="16" fill="#6b7280">2024-06-15 · 种子数据占位图</text>
  <line x1="24" y1="110" x2="336" y2="110" stroke="#e5e7eb"/>
  ${rowSvg}
  <line x1="24" y1="300" x2="336" y2="300" stroke="#e5e7eb"/>
  <text x="24" y="336" font-size="14" fill="#9ca3af">该图为本地占位，可在批次详情上传真实单据替换。</text>
</svg>`;
  await writeFile(filePath, svg, "utf-8");
  return filePath;
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

  const batch = await prisma.batch.create({
    data: {
      name: "2024-06 销售单据批次",
      status: "processing",
      strategy: "balanced",
      notes: "种子数据，用于本地验证界面和 API。",
    },
  });

  const receiptPath = await writeSeedReceipt();
  const doc = await prisma.document.create({
    data: {
      batchId: batch.id,
      originalName: "单据_20240615_0123.svg",
      storedPath: receiptPath,
      hash: "seed-doc-0123",
      mimeType: "image/svg+xml",
      sizeBytes: 0,
      status: "extracted",
      reviewStatus: "pending",
      riskLevel: "medium",
    },
  });

  const rows = [
    ["A1001", "苹果", "kg", 10, 8.5, 85, "low", "[]"],
    ["A1002", "香蕉", "kg", 5, 6, 30, "medium", "[\"NAME_MULTI_UNIT\"]"],
    ["B2001", "牛奶", "箱", 2, 45, 90, "medium", "[\"NAME_MULTI_UNIT\"]"],
    ["", "合计", "", 3, 68, 205, "high", "[\"INVALID_PRODUCT_NAME\",\"AMOUNT_MISMATCH\"]"],
  ] as const;

  for (const [index, row] of rows.entries()) {
    await prisma.recognitionRow.create({
      data: {
        batchId: batch.id,
        documentId: doc.id,
        rowIndex: index + 1,
        rawDate: "2024-06-15",
        normalizedMonth: "2024年6月",
        code: row[0],
        name: row[1],
        unit: row[2],
        qty: row[3],
        price: row[4],
        amount: row[5],
        riskLevel: row[6],
        riskReasonsJson: row[7],
        status: row[6] === "high" ? "conflict" : "pending",
        conflictState: row[6] === "low" ? "none" : "open",
      },
    });
  }

  await prisma.product.createMany({
    data: [
      { code: "A1001", name: "苹果", unit: "kg" },
      { code: "A1002", name: "香蕉", unit: "kg" },
      { code: "B2001", name: "牛奶", unit: "箱" },
    ],
  });

  const bad = await prisma.product.create({
    data: { name: "合计", status: "active" },
  });
  await prisma.productConflict.create({
    data: {
      productId: bad.id,
      type: "INVALID_PRODUCT_NAME",
      severity: "high",
      reason: "疑似非商品名",
    },
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
