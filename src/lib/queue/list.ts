import { prisma } from "@/lib/db/client";

/**
 * 队列只读查询。
 *
 * 队列的「事实」由 RecognitionJob 承载，但此前没有任何接口能列出它。
 * 这里提供全局作业列表（可按状态/类型/批次筛选 + 分页 + 各状态计数），
 * 供队列页可视化与维护。读操作无需事务，直接走默认 prisma。
 */

/** 队列页可筛选的作业状态集合（与 worker / 维护动作写入的状态一致）。 */
export const QUEUE_JOB_STATUSES = ["queued", "active", "completed", "failed", "cancelled"] as const;
/** 作业类型集合（extract/second_pass/consensus/audit）。 */
export const QUEUE_JOB_TYPES = ["extract", "second_pass", "consensus", "audit"] as const;

export interface ListJobsParams {
  status?: string;
  type?: string;
  batchId?: string;
  page: number;
  pageSize: number;
}

export async function listJobs({ status, type, batchId, page, pageSize }: ListJobsParams) {
  const where = {
    ...(status ? { status } : {}),
    ...(type ? { type } : {}),
    ...(batchId ? { batchId } : {}),
  };

  const [jobs, total, grouped] = await Promise.all([
    prisma.recognitionJob.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        document: {
          select: {
            id: true,
            originalName: true,
            status: true,
            sourceType: true,
            sourceFile: true,
            sourceEntry: true,
            pageNumber: true,
            pageCount: true,
          },
        },
        batch: { select: { id: true, name: true } },
      },
    }),
    prisma.recognitionJob.count({ where }),
    // 各状态计数始终覆盖全量（不受 where 筛选影响），用于队列页概览条。
    prisma.recognitionJob.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);

  const counts = Object.fromEntries(grouped.map((entry) => [entry.status, entry._count._all]));
  return { jobs, total, page, pageSize, counts };
}
