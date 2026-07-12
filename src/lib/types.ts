export type BatchStatus =
  | "draft"
  | "processing"
  | "needs_review"
  | "completed"
  | "failed"
  | "paused"
  | "imported";

export type RiskLevel = "low" | "medium" | "high";
export type RowStatus = "pending" | "confirmed" | "needs_review" | "conflict" | "excluded";
export type JobStatus = "queued" | "active" | "retrying" | "completed" | "failed" | "cancelled";

export type RecognitionStrategy = "fast" | "balanced" | "consensus" | "manual";

export interface BatchSummary {
  id: string;
  name: string;
  status: BatchStatus;
  documents: number;
  rows: number;
  failed: number;
  needsReview: number;
  strategy: RecognitionStrategy;
  createdAt: string;
  updatedAt: string;
  progress: number;
}

export interface DocumentSummary {
  id: string;
  fileName: string;
  status: "queued" | "processing" | "extracted" | "failed" | "reviewed";
  rows: number;
  risk: RiskLevel;
  failedReason?: string;
  updatedAt: string;
  attempts: ExtractionAttempt[];
}

export interface ExtractionAttempt {
  id: string;
  provider: string;
  model: string;
  status: JobStatus;
  startedAt: string;
  completedAt?: string;
  latencyMs?: number;
  error?: string;
}

export interface RecognitionRow {
  id: string;
  batchId: string;
  batchName: string;
  documentId: string;
  documentName: string;
  month: string;
  code: string;
  name: string;
  unit: string;
  qty: number;
  price: number;
  amount: number;
  risk: RiskLevel;
  status: RowStatus;
  reviewClass: string;
  auditState?: string;
  auditNote?: string;
  /** 命中的风险/冲突原因码（经规则字典翻成中文释义渲染）。 */
  riskReasons?: string[];
  /** @deprecated 用 riskReasons 经字典渲染；保留兼容旧展示。 */
  conflictReason?: string;
  remark?: string;
  sourceRegionJson?: string | null;
  /** 场景声明的非核心字段（来自 RecognitionRow.extraJson） */
  extra: Record<string, string>;
  updatedAt: string;
}

export interface ProductItem {
  id: string;
  code: string;
  name: string;
  unit: string;
  aliases: string[];
  observationCount: number;
  sourceDocuments: number;
  multiCodeNote?: string;
  multiUnitNote?: string;
  conflict: boolean;
  conflictReason?: string;
  lastSeenAt: string;
}

export interface ConflictItem {
  id: string;
  type: string;
  severity: RiskLevel;
  reason: string;
  product: string;
  sourceCount: number;
  status: "open" | "resolved" | "ignored";
}
