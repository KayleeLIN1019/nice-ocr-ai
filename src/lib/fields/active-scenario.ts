import { prisma } from "@/lib/db/client";
import { DEFAULT_SCENARIO_ID, getScenario, getScenarioFields, SCENARIOS } from "@/lib/fields/field-schema";

/** 活动场景 id 存于 AppSetting，缺省回退默认场景。 */
const activeScenarioKey = "fields.activeScenario";

export async function getActiveScenarioId(): Promise<string> {
  const setting = await prisma.appSetting.findUnique({ where: { key: activeScenarioKey } });
  const id = setting?.valueJson ? safeParseId(setting.valueJson) : null;
  return id && SCENARIOS[id] ? id : DEFAULT_SCENARIO_ID;
}

export async function setActiveScenarioId(id: string): Promise<string> {
  const next = SCENARIOS[id] ? id : DEFAULT_SCENARIO_ID;
  await prisma.appSetting.upsert({
    where: { key: activeScenarioKey },
    create: { key: activeScenarioKey, valueJson: JSON.stringify(next) },
    update: { valueJson: JSON.stringify(next) },
  });
  return next;
}

export async function getActiveScenario() {
  return getScenario(await getActiveScenarioId());
}

export async function getActiveScenarioFields() {
  return getScenarioFields(await getActiveScenarioId());
}

function safeParseId(raw: string): string | null {
  try {
    const value = JSON.parse(raw);
    return typeof value === "string" ? value : null;
  } catch {
    return typeof raw === "string" ? raw : null;
  }
}
