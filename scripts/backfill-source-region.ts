import "dotenv/config";

import path from "node:path";
import { prisma } from "@/lib/db/client";
import { logger } from "@/lib/logger";
import { getRecognitionDefaults } from "@/lib/recognition/settings";
import { createOcrLayoutProvider } from "@/lib/recognition/ocr-layout";
import { matchRowsToLayout } from "@/lib/recognition/source-region-match";
import { serializeSourceRegion } from "@/lib/recognition/source-region";

/**
 * 回填已识别行的原图来源区域：用本地 OCR 版面服务的真实文字框覆盖旧的模型估算坐标。
 * 无需重跑识别即可让历史单据的行级定位变准。
 *
 * 用法（需先启动 tools/ocr-layout 服务并配置 OCR_LAYOUT_URL / 设置页 ocrLayoutUrl）：
 *   npm run db:backfill-source-region            # 回填全部有识别行的文档
 *   npm run db:backfill-source-region <documentId>  # 只回填指定文档
 */
async function main() {
  const defaults = await getRecognitionDefaults();
  const provider = createOcrLayoutProvider(defaults.ocrLayoutUrl);
  if (!provider) {
    throw new Error("未配置 OCR 版面服务：请设置 OCR_LAYOUT_URL 环境变量或设置页 ocrLayoutUrl");
  }

  const onlyDoc = process.argv[2];
  const documents = await prisma.document.findMany({
    where: { ...(onlyDoc ? { id: onlyDoc } : {}), storedPath: { not: "" } },
    select: { id: true, storedPath: true, originalName: true },
  });

  let totalHit = 0;
  let totalRows = 0;
  for (const doc of documents) {
    const rows = await prisma.recognitionRow.findMany({
      where: { documentId: doc.id, deletedAt: null },
      orderBy: { rowIndex: "asc" },
      select: { id: true, code: true, name: true },
    });
    if (!rows.length) continue;
    totalRows += rows.length;
    try {
      const layout = await provider.layout({ imagePath: path.resolve(doc.storedPath) });
      const matched = matchRowsToLayout(
        rows.map((row) => ({ code: row.code, name: row.name })),
        layout,
      );
      let hit = 0;
      for (const [index, region] of matched.entries()) {
        if (!region) continue;
        await prisma.recognitionRow.update({
          where: { id: rows[index].id },
          data: { sourceRegionJson: serializeSourceRegion(region) },
        });
        hit += 1;
      }
      totalHit += hit;
      logger.info(`backfill doc=${doc.id} ${doc.originalName} lines=${layout.lines.length} matched=${hit}/${rows.length}`);
    } catch (error) {
      logger.warn(`backfill doc=${doc.id} skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  logger.info(`backfill done: matched ${totalHit}/${totalRows} rows across ${documents.length} document(s)`);
  await prisma.$disconnect();
}

main().catch((error) => {
  logger.error(`backfill crashed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exit(1);
});
