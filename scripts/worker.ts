import "dotenv/config";

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/db/client";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import {
  createRecognitionProvider,
  extractionConfigForScenario,
  resolveProviderPrompts,
  type RecognitionProvider,
  type RecognitionProviderResult,
} from "@/lib/recognition/provider";
import {
  buildRecognitionPrompt,
  defaultRecognitionPrompts,
  getRecognitionDefaults,
  normalizeRecognitionStrategy,
  resolveAuditRecognitionTarget,
  resolveRecognitionProviders,
  type RecognitionDefaults,
} from "@/lib/recognition/settings";
import { getScenario, getScenarioFields } from "@/lib/fields/field-schema";
import { claimNextJob } from "@/lib/queue/jobs";
import { applyBrandRules, validateRow } from "@/lib/validation/rules";
import {
  buildConsensusFlags,
  decideRowReview,
  normalizeApprovalMode,
  shouldRunConsensus,
} from "@/lib/recognition/review";
import {
  auditRowByRules,
  buildAuditStats,
  findDuplicateRowIds,
  type AuditableRow,
} from "@/lib/recognition/audit";
import { serializeSourceRegion } from "@/lib/recognition/source-region";
import { createOcrLayoutProvider } from "@/lib/recognition/ocr-layout";
import { matchRowsToLayout } from "@/lib/recognition/source-region-match";
import type { ExtractionRow } from "@/lib/recognition/schema";

const workerId = `worker-${process.pid}`;

type ClaimedJob = NonNullable<Awaited<ReturnType<typeof claimNextJob>>>;

async function recordAttempt(
  job: ClaimedJob,
  result: RecognitionProviderResult,
  pass: number,
  startedAt: number,
  strategy = job.batch.strategy,
) {
  const attemptDir = path.join(env.storageDir, "attempts", job.documentId);
  await mkdir(attemptDir, { recursive: true });
  const rawOutputPath = path.join(attemptDir, `${job.id}-pass${pass}.json`);
  await writeFile(rawOutputPath, JSON.stringify(result.rawResponse, null, 2), "utf8");

  return prisma.extractionAttempt.create({
    data: {
      documentId: job.documentId,
      jobId: job.id,
      providerKey: result.providerKey,
      model: result.model,
      promptVersion: "v1",
      schemaVersion: "v1",
      strategy,
      status: "completed",
      rawOutputPath,
      parsedJson: JSON.stringify(result.extraction),
      validationJson: JSON.stringify({ normalizedMonth: result.extraction.normalizedMonth, pass }),
      tokenUsageJson: result.tokenUsage ? JSON.stringify(result.tokenUsage) : undefined,
      latencyMs: Date.now() - startedAt,
      completedAt: new Date(),
    },
  });
}

async function recognizePass(provider: RecognitionProvider, job: ClaimedJob, imageBase64: string, pass: number, strategy?: string) {
  const startedAt = Date.now();
  const result = await provider.recognize({ imageBase64, mimeType: job.document.mimeType });
  const attempt = await recordAttempt(job, result, pass, startedAt, strategy);
  return { result, attempt };
}

// ---------- 识别(extract / second_pass / consensus) ----------

/**
 * 批次绑定场景的抽取上下文：动态 schema/normalize + 按场景生成的提示词回退。
 * 默认场景（grocery）走默认配置且提示词与内置默认等价 → 现有批次零行为变更。
 */
function scenarioContext(job: ClaimedJob) {
  const scenarioId = job.batch.scenarioId ?? null;
  const fields = getScenarioFields(scenarioId);
  return {
    extraction: extractionConfigForScenario(scenarioId),
    promptFallback: buildRecognitionPrompt(getScenario(scenarioId), fields),
    hasExtra: fields.some((field) => !field.core),
  };
}

function resolveContextPrompts(
  config: Parameters<typeof resolveProviderPrompts>[0],
  defaults: RecognitionDefaults,
  fallback: Parameters<typeof resolveProviderPrompts>[2],
) {
  const defaultPromptsUnchanged =
    defaults.systemPrompt === defaultRecognitionPrompts.systemPrompt &&
    defaults.userPrompt === defaultRecognitionPrompts.userPrompt;
  return resolveProviderPrompts(config, defaultPromptsUnchanged ? undefined : defaults, fallback);
}

/**
 * 行级原图来源区域：按设置策略产出每行 sourceRegionJson（与 canonicalRows 等长）。
 * - off：不存。
 * - model：用多模态模型自报坐标（精度不稳，旧行为）。
 * - layout_ocr：调本地 OCR 版面服务取真实文字框，按编码/名称匹配到行；未命中项回退模型坐标。
 *   OCR 不可用/出错时整体回退模型坐标，绝不让识别失败。
 */
async function resolveSourceRegions(
  job: ClaimedJob,
  rows: ExtractionRow[],
  defaults: RecognitionDefaults,
): Promise<Array<string | undefined>> {
  if (defaults.sourceRegionMode === "off") return rows.map(() => undefined);
  const modelRegions = rows.map((row) => serializeSourceRegion(row.sourceRegion));
  if (defaults.sourceRegionMode !== "layout_ocr") return modelRegions;

  const provider = createOcrLayoutProvider(defaults.ocrLayoutUrl);
  if (!provider) return modelRegions;
  try {
    const layout = await provider.layout({ imagePath: path.resolve(job.document.storedPath) });
    const matched = matchRowsToLayout(rows, layout);
    const merged = rows.map((_, index) => serializeSourceRegion(matched[index]) ?? modelRegions[index]);
    logger.info(
      `${workerId} ocr-layout doc=${job.documentId} lines=${layout.lines.length} matched=${matched.filter(Boolean).length}/${rows.length}`,
    );
    return merged;
  } catch (error) {
    logger.warn(
      `${workerId} ocr-layout doc=${job.documentId} fallback→model: ${error instanceof Error ? error.message : String(error)}`,
    );
    return modelRegions;
  }
}

/** 名称→主导单位映射：归一化名称后取每个名称最常见的单位（task 2 单位补空）。 */
function buildUnitByName(rows: Array<{ name: string; unit: string | null | undefined }>): Map<string, string> {
  const counts = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const key = String(row.name ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, "").trim();
    const unit = row.unit?.trim();
    if (!key || !unit) continue;
    const byUnit = counts.get(key) ?? new Map<string, number>();
    byUnit.set(unit, (byUnit.get(unit) ?? 0) + 1);
    counts.set(key, byUnit);
  }
  const result = new Map<string, string>();
  for (const [key, byUnit] of counts) {
    let best = "";
    let bestCount = 0;
    for (const [unit, count] of byUnit) {
      if (count > bestCount) {
        best = unit;
        bestCount = count;
      }
    }
    if (best) result.set(key, best);
  }
  return result;
}

async function extractDocument(job: ClaimedJob) {
  // 进入识别即把文档标记为「处理中」，让文件列表能区分「排队」与「正在识别」。
  await prisma.document.update({ where: { id: job.documentId }, data: { status: "processing" } });
  const imageBase64 = (await readFile(job.document.storedPath)).toString("base64");
  const { extraction, promptFallback, hasExtra } = scenarioContext(job);

  // 双模型交叉验证：pass1 主模型、pass2 副模型（提示词按 provider 覆盖→全局→场景生成）。
  const { primary, secondary, defaults } = await resolveRecognitionProviders(job.batch);
  const strategy = normalizeRecognitionStrategy(job.batch.strategy, defaults.strategy);
  const mode = strategy === "manual" ? "manual" : normalizeApprovalMode(job.batch.approvalMode);
  const prompts = resolveContextPrompts(primary.provider, defaults, promptFallback);
  const primaryProvider = createRecognitionProvider(primary, prompts, extraction);

  // 双模型并行：两次识别相互独立，不必等主模型跑完再跑副模型。
  // 是否需要一致性比对在拿到主结果前就能确定——只取决于 strategy/mode，与行内容无关：
  // 传 hasAutoCandidate=true 做「按可能存在自动候选」预判，manual 模式与 manual/fast 策略
  // 返回 false，其余模式返回 true。balanced+hybrid 且整页都非低风险时，副模型结果不会改变
  // 任何判定（无低风险行就不可能 ai_auto），此前串行逻辑借此省掉该次调用；并行后改为始终
  // 发起，用一次额外调用换取整体延迟减半，属可接受取舍。
  // 注：此处并发的是云端模型调用（OpenAI/Anthropic SDK 天生支持并发）；本地 PaddleOCR 版面
  // 服务的并发问题在 resolveSourceRegions 内单独处理，不受影响。
  const runConsensus = shouldRunConsensus(strategy, mode, true);
  const secondPass = runConsensus
    ? recognizePass(
        secondary.provider.id === primary.provider.id && secondary.model.id === primary.model.id
          ? primaryProvider
          : createRecognitionProvider(secondary, resolveContextPrompts(secondary.provider, defaults, promptFallback), extraction),
        job,
        imageBase64,
        2,
        strategy,
      )
    : Promise.resolve(null);

  // pass1 主模型（canonical 结果）与 pass2 副模型并发执行。
  const [first, second] = await Promise.all([
    recognizePass(primaryProvider, job, imageBase64, 1, strategy),
    secondPass,
  ]);
  const canonicalRows = first.result.extraction.rows;
  const consensusFlags = second
    ? buildConsensusFlags(canonicalRows, second.result.extraction.rows, defaults.amountTolerance)
    : canonicalRows.map(() => false);

  await prisma.recognitionRow.deleteMany({
    where: { documentId: job.documentId, status: { not: "confirmed" } },
  });

  const sourceRegions = await resolveSourceRegions(job, canonicalRows, defaults);

  // 历史校验基线（D#3）：导入的历史成交记录 + 系统已确认行（含单价/单位），
  // 用于在识别阶段直接做「单价离群 / 单位与历史不一致」的多重校验并标记风险。
  const [confirmedHistory, importedHistory] = await Promise.all([
    prisma.recognitionRow.findMany({
      where: { status: "confirmed", deletedAt: null },
      select: { code: true, name: true, unit: true, qty: true, price: true, amount: true },
    }),
    prisma.productPriceHistory.findMany({ select: { code: true, name: true, unit: true, price: true } }),
  ]);
  const historyStats = buildAuditStats([
    ...confirmedHistory,
    ...importedHistory.map((h) => ({ code: h.code, name: h.name, unit: h.unit, qty: 0, price: h.price, amount: 0 })),
  ]);

  // 名称→主导单位（task 2「补空」）：以历史成交（已确认行 + 导入历史，即产品库基线）聚合，
  // 识别单位为空时按产品名补全；非空不覆盖（冲突交由 UNIT_MISMATCH 标风险）。
  const unitByName = buildUnitByName([
    ...confirmedHistory.map((h) => ({ name: h.name, unit: h.unit })),
    ...importedHistory.map((h) => ({ name: h.name, unit: h.unit })),
  ]);

  let hasHighRisk = false;
  let autoApproved = 0;
  for (const [index, row] of canonicalRows.entries()) {
    // 品牌硬规则（item 3）。名称纠正不再自动套用——改由审核台「建议」，避免把正确行改错。
    const name = applyBrandRules(row.name);
    // task 2「补空」：单位为空时按产品名从库补全（仅未确认行经此落库，不动已确认数据）。
    const nameKey = name.normalize("NFKC").toLowerCase().replace(/\s+/g, "").trim();
    const unit = row.unit && row.unit.trim() ? row.unit : unitByName.get(nameKey) ?? row.unit;
    const validation = validateRow({ code: row.code ?? "", name, qty: row.qty, price: row.price, amount: row.amount });
    // 历史多重校验：仅取历史相关原因（规则原因已由 validateRow 覆盖，避免重复）。
    const historyReasons = auditRowByRules(
      { code: validation.cleanCode, name, unit, qty: row.qty, price: row.price, amount: row.amount },
      historyStats,
      { priceOutlierRatio: 3, minHistory: 3 },
    ).reasons.filter((reason) => reason === "PRICE_OUTLIER" || reason === "UNIT_MISMATCH");
    // 合并规则原因 + 历史原因；命中历史异常即降低置信：low→medium，高风险（如非商品名）保持 high。
    const reasons = [...validation.reasons, ...historyReasons];
    const riskLevel =
      validation.riskLevel === "high" ? "high" : reasons.length ? "medium" : "low";
    // 数量为 0 一票否决自动通过（blockAuto），无论审批模式都转人工。
    const decision = decideRowReview(mode, riskLevel, consensusFlags[index] ?? false, Number(row.qty) <= 0);
    if (riskLevel === "high") hasHighRisk = true;
    if (decision.reviewClass === "ai_auto") autoApproved += 1;

    await prisma.recognitionRow.create({
      data: {
        batchId: job.batchId,
        documentId: job.documentId,
        canonicalAttemptId: first.attempt.id,
        rowIndex: index + 1,
        rawDate: first.result.extraction.rawDate,
        normalizedMonth: first.result.extraction.normalizedMonth,
        code: validation.cleanCode,
        name,
        unit,
        qty: row.qty,
        price: row.price,
        amount: row.amount,
        remark: row.remark,
        status: decision.status,
        reviewClass: decision.reviewClass,
        riskLevel,
        riskReasonsJson: JSON.stringify(reasons),
        conflictState: reasons.length ? "open" : "none",
        sourceRegionJson: sourceRegions[index],
        // 非默认场景声明了 extra 字段时落库 extraJson；grocery 无 extra → 不写（保持默认 "{}"）。
        ...(hasExtra ? { extraJson: JSON.stringify(row.extra ?? {}) } : {}),
      },
    });
  }

  await prisma.document.update({
    where: { id: job.documentId },
    data: {
      status: "extracted",
      reviewStatus: autoApproved === canonicalRows.length && canonicalRows.length > 0 ? "auto_approved" : "pending",
      riskLevel: hasHighRisk ? "high" : "low",
    },
  });

  logger.info(
    `${workerId} done doc=${job.documentId} mode=${mode} primary=${primary.provider.providerKey}/${primary.model.modelId} secondary=${secondary.provider.providerKey}/${secondary.model.modelId} rows=${canonicalRows.length} auto=${autoApproved}`,
  );
}

// ---------- 审核(audit) ：对 ai_auto 行二次复查 ----------

const reasonLabels: Record<string, string> = {
  RULE_VIOLATION: "规则校验异常",
  PRICE_OUTLIER: "单价偏离历史",
  UNIT_MISMATCH: "单位与历史不一致",
  DUPLICATE_ROW: "文档内重复行",
  AI_DISAGREE: "第三次识别不一致",
};

function toAuditable(row: { id: string; code: string | null; name: string; unit: string | null; qty: number; price: number; amount: number }): AuditableRow {
  return { id: row.id, code: row.code, name: row.name, unit: row.unit, qty: row.qty, price: row.price, amount: row.amount };
}

async function auditDocument(job: ClaimedJob) {
  // 仅复查"机器自动通过(ai_auto)"且已确认的行——唯一无人复核的盲区。
  const aiAutoRows = await prisma.recognitionRow.findMany({
    where: { documentId: job.documentId, reviewClass: "ai_auto", status: "confirmed", deletedAt: null },
    orderBy: { rowIndex: "asc" },
  });

  if (!aiAutoRows.length) {
    logger.info(`${workerId} audit doc=${job.documentId} aiAuto=0 flagged=0 (skip)`);
    return;
  }

  const { primary, secondary, defaults } = await resolveRecognitionProviders(job.batch);

  // Stage 1：规则/统计预筛（零 API）。历史基线取所有已确认行（含单价，ProductObservation 不存价）。
  const history = await prisma.recognitionRow.findMany({
    where: { status: "confirmed", deletedAt: null },
    select: { code: true, name: true, unit: true, qty: true, price: true, amount: true },
  });
  const stats = buildAuditStats(history.map((row) => ({ ...row })));
  const auditables = aiAutoRows.map(toAuditable);
  const duplicateIds = findDuplicateRowIds(auditables);

  const reasonsByRow = new Map<string, string[]>();
  for (const row of auditables) {
    const { reasons } = auditRowByRules(row, stats, { priceOutlierRatio: 3, minHistory: 3 });
    const list = [...reasons];
    if (duplicateIds.has(row.id as string)) list.push("DUPLICATE_ROW");
    reasonsByRow.set(row.id as string, list);
  }

  const stage1Suspicious = auditables.some((row) => (reasonsByRow.get(row.id as string) ?? []).length > 0);

  // Stage 2：第三次独立 AI 交叉验证。可疑文档必跑；干净文档按抽样率跑（成本可控）。
  const sampleRate = Math.min(1, Math.max(0, defaults.auditSampleRate ?? 0.1));
  const runStage2 = stage1Suspicious || Math.random() < sampleRate;

  let stage2 = false;
  const suggestionByRow = new Map<string, AuditableRow>();
  if (runStage2) {
    try {
      const { extraction, promptFallback } = scenarioContext(job);
      const auditProvider = await resolveAuditProvider(primary, secondary, defaults.auditProviderKey, defaults.auditModelId);
      const imageBase64 = (await readFile(job.document.storedPath)).toString("base64");
      const pass = await recognizePass(
        createRecognitionProvider(auditProvider, resolveContextPrompts(auditProvider.provider, defaults, promptFallback), extraction),
        job,
        imageBase64,
        3,
        "audit",
      );
      const auditRows = pass.result.extraction.rows;
      // 第三次是否复现了每个 ai_auto 行；未复现 → 不一致。
      const reproduced = buildConsensusFlags(auditables, auditRows, defaults.amountTolerance);
      auditables.forEach((row, index) => {
        if (!reproduced[index]) {
          reasonsByRow.get(row.id as string)?.push("AI_DISAGREE");
          // 建议值：第三次中同名（去空白）的行。
          const match = auditRows.find((other) => normalize(other.name) === normalize(row.name));
          if (match) {
            suggestionByRow.set(row.id as string, {
              code: match.code ?? null,
              name: match.name,
              unit: match.unit ?? null,
              qty: match.qty,
              price: match.price,
              amount: match.amount,
            });
          }
        }
      });
      stage2 = true;
    } catch (error) {
      // 无可用审核 provider 或调用失败 → 仅用 Stage1 结果，不让审核任务失败。
      logger.warn(`${workerId} audit doc=${job.documentId} stage2 skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let flagged = 0;
  for (const row of auditables) {
    const reasons = reasonsByRow.get(row.id as string) ?? [];
    const isFlagged = reasons.length > 0;
    if (isFlagged) flagged += 1;
    const suggestion = suggestionByRow.get(row.id as string);
    await prisma.recognitionRow.update({
      where: { id: row.id as string },
      data: {
        auditState: isFlagged ? "flagged" : "passed",
        auditNote: isFlagged ? reasons.map((reason) => reasonLabels[reason] ?? reason).join("、") : null,
        auditSuggestionJson: suggestion ? JSON.stringify(suggestion) : null,
        auditedAt: new Date(),
      },
    });
  }

  await prisma.auditLog.create({
    data: {
      entityType: "Document",
      entityId: job.documentId,
      action: "audit",
      afterJson: JSON.stringify({ aiAuto: auditables.length, flagged, stage2 }),
    },
  });

  logger.info(
    `${workerId} audit doc=${job.documentId} aiAuto=${auditables.length} flagged=${flagged} stage2=${stage2}`,
  );
}

async function resolveAuditProvider(
  primary: Awaited<ReturnType<typeof resolveRecognitionProviders>>["primary"],
  secondary: Awaited<ReturnType<typeof resolveRecognitionProviders>>["secondary"],
  auditProviderKey: string | null,
  auditModelId: string | null,
) {
  return resolveAuditRecognitionTarget(primary, secondary, auditProviderKey, auditModelId);
}

function normalize(name: string): string {
  return String(name ?? "").replace(/\s+/g, "").trim();
}

// ---------- 调度 ----------

let shuttingDown = false;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 回收孤儿 active job：被 kill / 崩溃中断的 job 会停在 status="active"，
 * 而 claimNextJob 只领 queued，没有回收就会永久卡死该文档。把 lockedAt 早于
 * 阈值（按设置页退避秒数推导，至少 5min）的 active job 重置回 queued 使其可被重新领取。
 */
async function reclaimStaleJobs() {
  const defaults = await getRecognitionDefaults();
  const staleJobMs = Math.max(300_000, defaults.backoffSeconds * 1000 * defaults.maxAttempts * 2);
  const threshold = new Date(Date.now() - staleJobMs);
  const reclaimed = await prisma.recognitionJob.updateMany({
    where: { status: "active", lockedAt: { lt: threshold } },
    data: { status: "queued", lockedAt: null, lockedBy: null },
  });
  if (reclaimed.count > 0) {
    logger.info(`${workerId} reclaimed ${reclaimed.count} stale active job(s)`);
  }
}

/**
 * 识别队列排空后回写批次状态：上传时批次被置为 "processing"，但没有任何环节把它
 * 改回终态，导致批次永远停在「处理中」。这里在每个 job 结束后按「是否还有待处理识别
 * job」+「文档识别结果」推导批次终态：
 * - 仍有 extract/second_pass/consensus 在排队或执行 → 保持 processing（audit 属审核期不计）。
 * - 全部失败 → failed；部分失败 → needs_review；全部识别成功 → completed。
 */
async function refreshBatchStatus(batchId: string) {
  const pending = await prisma.recognitionJob.count({
    where: { batchId, type: { in: ["extract", "second_pass", "consensus"] }, status: { in: ["queued", "active"] } },
  });
  if (pending > 0) return;

  const groups = await prisma.document.groupBy({
    by: ["status"],
    where: { batchId },
    _count: { _all: true },
  });
  const total = groups.reduce((sum, group) => sum + group._count._all, 0);
  if (total === 0) return;
  const failed = groups.find((group) => group.status === "failed")?._count._all ?? 0;

  const status = failed === total ? "failed" : failed > 0 ? "needs_review" : "completed";
  await prisma.batch.update({ where: { id: batchId }, data: { status } });
}

/** 处理一个已领取的 job（完成 / 重试 / 失败落库）。不负责领取。 */
async function handleClaimedJob(job: ClaimedJob) {
  try {
    if (job.type === "audit") {
      await auditDocument(job);
    } else {
      await extractDocument(job);
    }
    await prisma.recognitionJob.update({
      where: { id: job.id },
      data: { status: "completed", lockedAt: null, lockedBy: null },
    });
    if (job.type !== "audit") await refreshBatchStatus(job.batchId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const defaults = await getRecognitionDefaults();
    const shouldRetry = job.attemptsMade < job.maxAttempts;
    await prisma.recognitionJob.update({
      where: { id: job.id },
      data: {
        status: shouldRetry ? "queued" : "failed",
        lastError: message,
        nextRunAt: new Date(Date.now() + defaults.backoffSeconds * 1000 * Math.max(1, job.attemptsMade)),
        lockedAt: null,
        lockedBy: null,
      },
    });
    if (job.type !== "audit") {
      await prisma.document.update({
        where: { id: job.documentId },
        data: { status: shouldRetry ? "queued" : "failed" },
      });
      // 终态失败（不再重试）才结算批次；仍会重试时保持 processing 等下次执行。
      if (!shouldRetry) await refreshBatchStatus(job.batchId);
    }
    logger.error(`${workerId} failed job=${job.id} type=${job.type}: ${message}`);
  }
}

async function main() {
  logger.info(`${workerId} started`);
  await reclaimStaleJobs();

  const inFlight = new Set<Promise<void>>();
  while (!shuttingDown) {
    const concurrency = (await getRecognitionDefaults()).queueConcurrency;
    // 填满并发槽：原子领取直到无 job 可领或槽位已满。
    while (!shuttingDown && inFlight.size < concurrency) {
      const job = await claimNextJob(workerId);
      if (!job) break;
      const task = handleClaimedJob(job).finally(() => {
        inFlight.delete(task);
      });
      inFlight.add(task);
    }

    if (inFlight.size === 0) {
      // 空闲：顺带回收陈旧 active job，然后退避。
      await reclaimStaleJobs();
      await sleep(2000);
    } else {
      // 等任意一个完成，腾出槽位继续领取。
      await Promise.race(inFlight);
    }
  }

  // 优雅停机：不再领新 job，等在途 job 跑完再断开连接。
  logger.info(`${workerId} shutting down, draining ${inFlight.size} in-flight job(s)...`);
  await Promise.allSettled(inFlight);
  await prisma.$disconnect();
  logger.info(`${workerId} stopped`);
}

function requestShutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${workerId} received ${signal}, will stop after in-flight jobs finish`);
}
process.on("SIGTERM", () => requestShutdown("SIGTERM"));
process.on("SIGINT", () => requestShutdown("SIGINT"));

main().catch((error) => {
  logger.error("worker crashed", { error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
  process.exit(1);
});
