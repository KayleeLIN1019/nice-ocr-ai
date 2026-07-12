import { cleanProductCode, isInvalidProductName, isShortProductCode } from "@/lib/validation/rules";

export type ProductObservationLike = {
  rowId: string;
  code?: string | null;
  name: string;
  unit?: string | null;
};

export function normalizedConflictCode(code?: string | null) {
  const clean = cleanProductCode(code);
  return clean && !isShortProductCode(clean) ? clean : "";
}

export function detectProductConflictReasons(observations: ProductObservationLike[]) {
  const nameToCodes = new Map<string, Set<string>>();
  const codeToNames = new Map<string, Set<string>>();
  const nameToUnits = new Map<string, Set<string>>();
  const reasons = new Map<string, string[]>();

  for (const observation of observations) {
    const code = normalizedConflictCode(observation.code);
    if (observation.name) {
      if (!nameToCodes.has(observation.name)) nameToCodes.set(observation.name, new Set());
      if (code) nameToCodes.get(observation.name)?.add(code);
      if (!nameToUnits.has(observation.name)) nameToUnits.set(observation.name, new Set());
      if (observation.unit) nameToUnits.get(observation.name)?.add(observation.unit);
    }
    if (code) {
      if (!codeToNames.has(code)) codeToNames.set(code, new Set());
      codeToNames.get(code)?.add(observation.name);
    }
  }

  for (const observation of observations) {
    const clean = cleanProductCode(observation.code);
    const code = normalizedConflictCode(observation.code);
    const itemReasons: string[] = [];
    if (isInvalidProductName(observation.name)) itemReasons.push("INVALID_PRODUCT_NAME");
    if (observation.code && observation.code !== clean) itemReasons.push("CODE_CLEANED_BY_RULE");
    if (code && (codeToNames.get(code)?.size ?? 0) > 1) itemReasons.push("CODE_NAME_CONFLICT");
    if ((nameToCodes.get(observation.name)?.size ?? 0) > 1) itemReasons.push("NAME_MULTI_CODE");
    if ((nameToUnits.get(observation.name)?.size ?? 0) > 1) itemReasons.push("NAME_MULTI_UNIT");
    reasons.set(observation.rowId, itemReasons);
  }

  return reasons;
}
