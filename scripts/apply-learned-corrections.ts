import "dotenv/config";

import { prisma } from "@/lib/db/client";
import { normalizeCorrectionKey } from "@/lib/recognition/corrections";
import { applyBrandRules } from "@/lib/validation/rules";

/**
 * 对**现有未审核行**做安全回填，减少人工校验量。只做确定性、可追溯的安全操作：
 *  - 品牌硬规则：「xx 一级精品」→「雨润一级精品」。
 *  - 单位补空：单位为空时按产品名从产品库补全（不覆盖已有单位）。
 *  不动 riskLevel/status —— 仅 validateRow 重算会丢失 worker 的历史校验原因，反而不稳；
 *  这些行本就在审核队列里，回填只为让你少改字段，不改变它们的风险/状态归类。
 *
 * **不做**从编辑历史学到的名称替换——已证实会误伤（鸭爪→西瓜等），改由审核台「建议」承担。
 *
 * 安全边界：
 *  - 只动 status ∈ pending/needs_review/conflict 且未删除的行。
 *  - 跳过曾被人工编辑过的行（AuditLog 有该行 update 记录）——绝不覆盖你改过的数据。
 *  - 默认 dry-run；--apply 才写库，并写 AuditLog(action=auto_correct) 便于追溯/回滚。
 *
 * 用法：
 *   tsx scripts/apply-learned-corrections.ts                       # 预演（全部未审核行）
 *   tsx scripts/apply-learned-corrections.ts --apply --limit=100   # 回填前 100 行
 *   tsx scripts/apply-learned-corrections.ts --apply --batch=<id>  # 回填某批次
 */

function arg(name: string): string | undefined {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
  return hit ? hit.split("=")[1] : undefined;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const limit = arg("limit") ? Number(arg("limit")) : undefined;
  const batchId = arg("batch");

  // 产品库「产品名→单位」：用于给空单位补全。
  const products = await prisma.product.findMany({ select: { name: true, unit: true } });
  const unitByName = new Map<string, string>();
  for (const product of products) {
    const key = normalizeCorrectionKey(product.name);
    const unit = product.unit?.trim();
    if (key && unit && !unitByName.has(key)) unitByName.set(key, unit);
  }

  // 排除曾被人工编辑过的行（不动你改过的数据）。
  const edited = await prisma.auditLog.findMany({
    where: { entityType: "RecognitionRow", action: "update" },
    select: { entityId: true },
    distinct: ["entityId"],
  });
  const editedIds = new Set(edited.map((row) => row.entityId));

  const rows = await prisma.recognitionRow.findMany({
    where: {
      deletedAt: null,
      status: { in: ["pending", "needs_review", "conflict"] },
      ...(batchId ? { batchId } : {}),
    },
    orderBy: { createdAt: "asc" },
    ...(limit ? { take: limit } : {}),
  });

  let scanned = 0;
  let skippedEdited = 0;
  let changed = 0;
  let brandFixed = 0;
  let unitFilled = 0;
  const samples: string[] = [];

  for (const row of rows) {
    scanned += 1;
    if (editedIds.has(row.id)) {
      skippedEdited += 1;
      continue;
    }

    const newName = applyBrandRules(row.name);
    const hasUnit = Boolean(row.unit && row.unit.trim());
    const filledUnit = hasUnit ? row.unit : unitByName.get(normalizeCorrectionKey(newName)) ?? row.unit;

    const nameChanged = newName !== row.name;
    const unitChanged = filledUnit !== row.unit;
    if (!nameChanged && !unitChanged) continue;

    changed += 1;
    if (nameChanged) brandFixed += 1;
    if (unitChanged) unitFilled += 1;

    if (samples.length < 15) {
      const tags = [nameChanged ? "品牌" : "", unitChanged ? "补单位" : ""].filter(Boolean).join("+");
      samples.push(`  [${tags}] "${row.name}"${row.unit ? `/${row.unit}` : "/—"} → "${newName}"/${filledUnit ?? "—"}`);
    }

    if (apply) {
      await prisma.$transaction(async (tx) => {
        await tx.recognitionRow.update({
          where: { id: row.id },
          data: { name: newName, unit: filledUnit },
        });
        await tx.auditLog.create({
          data: {
            entityType: "RecognitionRow",
            entityId: row.id,
            action: "auto_correct",
            beforeJson: JSON.stringify({ name: row.name, unit: row.unit }),
            afterJson: JSON.stringify({ name: newName, unit: filledUnit }),
          },
        });
      });
    }
  }

  console.log(
    `${apply ? "已回填" : "预演"}：扫描 ${scanned} 行，跳过已编辑 ${skippedEdited} 行，改动 ${changed} 行` +
      `（品牌规则 ${brandFixed} / 补单位 ${unitFilled}）。`,
  );
  if (samples.length) console.log(`样例（最多 15 条）：\n${samples.join("\n")}`);
  if (!apply && changed > 0) console.log(`\n这是预演，未写库。加 --apply 才实际回填。`);

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
