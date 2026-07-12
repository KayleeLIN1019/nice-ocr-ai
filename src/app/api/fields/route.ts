import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getActiveScenarioId, setActiveScenarioId } from "@/lib/fields/active-scenario";
import { getMetaFields, getScenarioFields, listScenarios } from "@/lib/fields/field-schema";
import { handleRoute, parseJson } from "@/lib/api/http";

export const runtime = "nodejs";

/**
 * 返回场景字段定义、元字段与可选场景列表，供前端动态出列与导出/识别共享。
 *
 * 作用域解析（均不改写全局活动场景）：
 * - `?scenarioId=` → 直接按该场景出列；
 * - `?batchId=`    → 解析该批次的 scenarioId 后出列（批次未绑定则回退全局活动场景）；
 * - 无参          → 全局活动场景（维持原行为）。
 * 响应中的 `activeScenarioId` 反映本次解析出的场景，便于前端展示。
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const scenarioParam = searchParams.get("scenarioId");
  const batchId = searchParams.get("batchId");

  let scenarioId: string;
  if (scenarioParam) {
    scenarioId = scenarioParam;
  } else if (batchId) {
    const batch = await prisma.batch.findUnique({ where: { id: batchId }, select: { scenarioId: true } });
    scenarioId = batch?.scenarioId ?? (await getActiveScenarioId());
  } else {
    scenarioId = await getActiveScenarioId();
  }

  return NextResponse.json({
    activeScenarioId: scenarioId,
    scenarios: listScenarios(),
    fields: getScenarioFields(scenarioId),
    metaFields: getMetaFields(),
  });
}

const scenarioSwitchSchema = z.object({ scenarioId: z.string().optional() });

/** 切换活动场景。 */
export async function POST(request: Request) {
  return handleRoute(async () => {
    const body = await parseJson(request, scenarioSwitchSchema);
    const scenarioId = await setActiveScenarioId(String(body.scenarioId ?? ""));
    return NextResponse.json({
      activeScenarioId: scenarioId,
      fields: getScenarioFields(scenarioId),
      metaFields: getMetaFields(),
    });
  });
}
