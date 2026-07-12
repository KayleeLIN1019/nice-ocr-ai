import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api/client";
import { apiPaths } from "@/lib/api/paths";
import type { FieldDef } from "@/lib/fields/field-schema";

export interface FieldSchemaPayload {
  activeScenarioId: string;
  scenarios: Array<{ id: string; name: string; description: string }>;
  /** 当前场景的有序识别字段（可编辑明细列） */
  fields: FieldDef[];
  /** 派生/只读元字段 */
  metaFields: FieldDef[];
}

/** 作用域：按批次（解析其场景）或直接指定场景；均不改写全局活动场景。缺省=全局活动场景。 */
export interface FieldSchemaScope {
  batchId?: string | null;
  scenarioId?: string | null;
}

/** 拉取场景字段定义，驱动结果表/审核台动态出列；可按批次/场景作用域取列。 */
export function useFieldSchema(scope?: FieldSchemaScope) {
  const params = new URLSearchParams();
  if (scope?.scenarioId) params.set("scenarioId", scope.scenarioId);
  else if (scope?.batchId) params.set("batchId", scope.batchId);
  const query = params.toString();

  return useQuery<FieldSchemaPayload>({
    queryKey: ["fields", query],
    queryFn: () => apiGet(query ? `${apiPaths.fields}?${query}` : apiPaths.fields),
    staleTime: 5 * 60 * 1000,
  });
}
