import { Badge } from "@/components/ui/badge";
import type { BatchStatus, JobStatus, RiskLevel, RowStatus } from "@/lib/types";

export function RiskBadge({ risk }: { risk: RiskLevel }) {
  const map = {
    low: { label: "低", tone: "success" as const },
    medium: { label: "中", tone: "warning" as const },
    high: { label: "高", tone: "danger" as const },
  };
  return <Badge tone={map[risk].tone}>{map[risk].label}</Badge>;
}

export function BatchStatusBadge({ status }: { status: BatchStatus }) {
  const map = {
    draft: { label: "草稿", tone: "neutral" as const },
    processing: { label: "处理中", tone: "info" as const },
    needs_review: { label: "待核查", tone: "warning" as const },
    completed: { label: "完成", tone: "success" as const },
    failed: { label: "失败", tone: "danger" as const },
    paused: { label: "已暂停", tone: "warning" as const },
    imported: { label: "导入", tone: "neutral" as const },
  };
  const item = map[status] ?? { label: status, tone: "neutral" as const };
  return <Badge tone={item.tone}>{item.label}</Badge>;
}

export function DocStatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; tone: "success" | "info" | "warning" | "danger" | "neutral" }> = {
    uploaded: { label: "已上传", tone: "neutral" },
    queued: { label: "排队中", tone: "neutral" },
    processing: { label: "识别中", tone: "info" },
    extracted: { label: "已识别", tone: "success" },
    reviewed: { label: "已审核", tone: "success" },
    failed: { label: "识别失败", tone: "danger" },
  };
  const item = map[status] ?? { label: status, tone: "neutral" as const };
  return <Badge tone={item.tone}>{item.label}</Badge>;
}

export function RowStatusBadge({ status }: { status: RowStatus }) {
  const map = {
    pending: { label: "待审核", tone: "warning" as const },
    confirmed: { label: "已确认", tone: "success" as const },
    needs_review: { label: "需复核", tone: "warning" as const },
    conflict: { label: "冲突", tone: "danger" as const },
    excluded: { label: "已排除", tone: "neutral" as const },
  };
  return <Badge tone={map[status].tone}>{map[status].label}</Badge>;
}

export function ReviewClassBadge({ value }: { value: string }) {
  const map: Record<string, { label: string; tone: "success" | "info" | "warning" | "danger" | "neutral" }> = {
    ai_auto: { label: "AI自动通过", tone: "success" },
    human: { label: "人工确认", tone: "info" },
    pending_review: { label: "待人工复核", tone: "warning" },
    conflict: { label: "冲突", tone: "danger" },
  };
  const item = map[value] ?? map.pending_review;
  return <Badge tone={item.tone}>{item.label}</Badge>;
}

export function AuditStateBadge({ value }: { value: string }) {
  const map: Record<string, { label: string; tone: "success" | "info" | "warning" | "danger" | "neutral" }> = {
    none: { label: "未审核", tone: "neutral" },
    passed: { label: "审核通过", tone: "success" },
    flagged: { label: "待复审", tone: "danger" },
    reviewed: { label: "已复审", tone: "info" },
  };
  const item = map[value] ?? map.none;
  return <Badge tone={item.tone}>{item.label}</Badge>;
}

const approvalModeLabels: Record<string, string> = {
  manual: "全人工",
  hybrid: "混合(AI+人工)",
  auto: "AI自动",
};

export function ApprovalModeBadge({ mode }: { mode: string }) {
  return <Badge tone="neutral">{approvalModeLabels[mode] ?? approvalModeLabels.hybrid}</Badge>;
}

export function JobStatusBadge({ status }: { status: JobStatus }) {
  const map = {
    queued: { label: "排队", tone: "neutral" as const },
    active: { label: "处理中", tone: "info" as const },
    retrying: { label: "重试中", tone: "warning" as const },
    completed: { label: "成功", tone: "success" as const },
    failed: { label: "失败", tone: "danger" as const },
    cancelled: { label: "已取消", tone: "neutral" as const },
  };
  return <Badge tone={map[status].tone}>{map[status].label}</Badge>;
}
