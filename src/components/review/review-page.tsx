"use client";

import {
  Boxes,
  Check,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Eraser,
  LocateFixed,
  LocateOff,
  Maximize2,
  Minimize2,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
  Wand2,
  X,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Panel, PanelHeader, PanelTitle } from "@/components/ui/card";
import {
  ApprovalModeBadge,
  AuditStateBadge,
  ReviewClassBadge,
  RowStatusBadge,
  RiskBadge,
} from "@/components/ui/status";
import { ModelErrorNote, ReasonList } from "@/components/ui/reason-badge";
import { DataTable, tableCellClass, tableHeadClass } from "@/components/ui/table";
import { FieldCell } from "@/components/ui/field-cell";
import { ImageViewer } from "@/components/ui/image-viewer";
import type { ImageRegion } from "@/components/ui/image-viewer";
import { BatchWorkspaceNav } from "@/components/batches/batch-workspace-nav";
import { BatchScopeSelect } from "@/components/batches/batch-scope-select";
import { useSidebar } from "@/components/app-shell/sidebar-context";
import { cn, formatDateTime } from "@/lib/utils";
import { RiskDetailDrawer } from "@/components/dialogs/action-dialogs";
import {
  DEFAULT_SCENARIO_ID,
  fieldCellWidthClass,
  getScenarioFields,
  isCoreColumn,
  type FieldDef,
} from "@/lib/fields/field-schema";
import { useFieldSchema } from "@/lib/fields/use-field-schema";
import { matchLibraryCandidates, normalizeMatchKey, type NameCandidate } from "@/lib/products/match";
import { apiGet, apiJson } from "@/lib/api/client";
import { apiPaths } from "@/lib/api/paths";
import { isShortProductCode } from "@/lib/validation/rules";
import type { RiskLevel, RowStatus } from "@/lib/types";

function safeParseObject(raw?: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

function safeParseStringArray(raw?: string | null): string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.map(String) : [];
  } catch {
    return [];
  }
}

interface ApiRow {
  id: string;
  rowIndex: number;
  code?: string | null;
  name: string;
  unit?: string | null;
  qty: number;
  price: number;
  amount: number;
  remark?: string | null;
  extraJson?: string | null;
  riskLevel: RiskLevel;
  status: RowStatus;
  reviewClass: string;
  riskReasonsJson?: string | null;
  auditState: string;
  auditNote?: string | null;
  auditSuggestionJson?: string | null;
  sourceRegionJson?: string | null;
  /** 副模型对该行读到的商品名（与主模型不同时由接口附带），作为审核台一键候选。 */
  altName?: string | null;
  fieldIssues?: ReviewFieldIssue[];
  triage?: ReviewRowTriage | null;
}

/** 取字段在审核行上的当前值：核心列直接取，非核心列从 extraJson 取。 */
function rowFieldValue(row: ApiRow, field: FieldDef): string | number {
  if (isCoreColumn(field.key)) {
    return (
      (row as unknown as Record<string, string | number>)[field.key] ?? (field.type === "number" ? 0 : "")
    );
  }
  return safeParseObject(row.extraJson)[field.key] ?? "";
}

interface ApiAttempt {
  id: string;
  providerKey: string;
  model: string;
  status: string;
  strategy: string;
  startedAt: string;
  completedAt?: string | null;
  error?: string | null;
}

interface ApiDocument {
  id: string;
  originalName: string;
  riskLevel: RiskLevel;
  riskReasonsJson?: string | null;
  rows: ApiRow[];
  attempts: ApiAttempt[];
  triage?: ReviewDocumentTriage;
}

type ReviewState = "pending" | "partial" | "confirmed" | "conflict";
type ReviewQueue = "manual" | "auto_pass" | "sample";
type ReviewField = "code" | "name" | "unit" | "qty" | "price" | "amount";

interface ReviewFieldIssue {
  field: ReviewField;
  code: string;
  severity: "info" | "warning" | "danger";
  message: string;
  action?: string;
  suggestion?: string;
}

interface ReviewRowTriage {
  id: string;
  priority: "high" | "medium" | "low";
  queue: ReviewQueue;
  needsHuman: boolean;
  fieldIssues: ReviewFieldIssue[];
  reasons: string[];
}

interface ReviewDocumentTriage {
  queue: ReviewQueue;
  autoPassEligible: boolean;
  blockers: string[];
  rowCounts: { total: number; confirmed: number; manual: number; autoPass: number; sample: number };
}

interface BulkSuggestion {
  id: string;
  type: "clear_short_codes" | "replace_code_by_name" | "replace_name_by_code" | "learned_correction";
  title: string;
  description: string;
  severity: "info" | "warning" | "danger";
  count: number;
  rowIds?: string[];
  name?: string;
  toCode?: string;
  code?: string;
  toName?: string;
  field?: "name" | "code";
  toValue?: string;
}

/** 跨批次审核待办文档（/api/documents 返回项）：每条标注所属批次。 */
interface WorklistDoc {
  id: string;
  originalName: string;
  batchId: string;
  batchName: string;
  riskLevel: RiskLevel;
  reviewState: ReviewState;
  rowStats: { total: number; confirmed: number; conflict: number };
}

const docStateBadge: Record<ReviewState, { label: string; tone: "warning" | "info" | "success" | "danger" }> =
  {
    pending: { label: "待复核", tone: "warning" },
    partial: { label: "部分确认", tone: "info" },
    confirmed: { label: "已确认", tone: "success" },
    conflict: { label: "冲突", tone: "danger" },
  };

const docFilters: Array<{ key: ReviewState | "all"; label: string }> = [
  { key: "all", label: "全部" },
  { key: "pending", label: "待复核" },
  { key: "partial", label: "部分确认" },
  { key: "confirmed", label: "已确认" },
  { key: "conflict", label: "冲突" },
];

const triageFilters: Array<{ key: ReviewQueue | "all"; label: string }> = [
  { key: "all", label: "全部队列" },
  { key: "manual", label: "必须人工" },
  { key: "auto_pass", label: "可一键过" },
  { key: "sample", label: "低风险抽检" },
];

const DOC_PAGE_SIZE = 8;

// 词语联想 <datalist> 元素 id（item 1）：明细表与新增草稿行的商品名/单位输入共用。
const SUGGEST_CODES_ID = "review-suggest-codes";
const SUGGEST_NAMES_ID = "review-suggest-names";
const SUGGEST_UNITS_ID = "review-suggest-units";

/** 文本字段对应的联想 datalist id（仅可编辑的商品名/单位）。 */
function fieldListId(field: FieldDef): string | undefined {
  if (!field.editable) return undefined;
  if (field.key === "code") return SUGGEST_CODES_ID;
  if (field.key === "name") return SUGGEST_NAMES_ID;
  if (field.key === "unit") return SUGGEST_UNITS_ID;
  return undefined;
}

function rowSourceRegion(row: ApiRow): ImageRegion["box"] | null {
  if (!row.sourceRegionJson) return null;
  try {
    const parsed = JSON.parse(row.sourceRegionJson) as { box?: Partial<ImageRegion["box"]> };
    const box = parsed.box;
    if (!box) return null;
    const x = Number(box.x);
    const y = Number(box.y);
    const w = Number(box.w);
    const h = Number(box.h);
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
    const safeX = Math.min(1, Math.max(0, x));
    const safeY = Math.min(1, Math.max(0, y));
    const safeW = Math.min(1 - safeX, Math.max(0, w));
    const safeH = Math.min(1 - safeY, Math.max(0, h));
    if (safeW <= 0 || safeH <= 0) return null;
    return { x: safeX, y: safeY, w: safeW, h: safeH };
  } catch {
    return null;
  }
}

function docQueue(doc: WorklistDoc): ReviewQueue {
  if (doc.reviewState === "conflict" || doc.riskLevel === "high") return "manual";
  if (doc.reviewState === "confirmed") return "sample";
  if (doc.riskLevel === "low" && doc.rowStats.conflict === 0 && doc.rowStats.confirmed < doc.rowStats.total) {
    return "auto_pass";
  }
  return "manual";
}

function queueBadge(queue: ReviewQueue): { label: string; tone: "info" | "success" | "warning" | "danger" } {
  if (queue === "manual") return { label: "人工", tone: "danger" };
  if (queue === "auto_pass") return { label: "可过", tone: "success" };
  return { label: "抽检", tone: "info" };
}

export function ReviewPage() {
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  // 作用域单一事实源：URL ?batchId=（null=全部跨批次待办）。
  const batchIdParam = searchParams.get("batchId");
  const documentIdParam = searchParams.get("documentId");
  const rowIdParam = searchParams.get("rowId");
  const [riskOpen, setRiskOpen] = useState(false);
  // 进入审核台时若带 ?documentId= 则直接定位该文档（来自批次详情/结果页/仪表盘的直达跳转）。
  const [override, setOverride] = useState<string | null>(documentIdParam);
  // 带 ?rowId= 时直达具体未审条目；普通切换单据时不沿用该定位。
  const [overrideRowId, setOverrideRowId] = useState<string | null>(rowIdParam);
  const [docSearch, setDocSearch] = useState("");
  const [docFilter, setDocFilter] = useState<ReviewState | "all">("all");
  const [triageFilter, setTriageFilter] = useState<ReviewQueue | "all">("all");
  const [docPage, setDocPage] = useState(1);
  const [focus, setFocus] = useState(false);
  const { setCollapsed } = useSidebar();
  // 行内删除二次确认：记录待删除行 id。
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // 新增草稿行：undefined=无草稿；null=末尾追加；string=在该行下方插入。
  const [draftAfterId, setDraftAfterId] = useState<string | null | undefined>(undefined);
  const [activeRowId, setActiveRowId] = useState<string | null>(null);
  const [targetRowId, setTargetRowId] = useState<string | null>(null);
  const [shortCodeScanActive, setShortCodeScanActive] = useState(false);
  const pageTopRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef<Record<string, HTMLTableRowElement | null>>({});
  const targetSequence = useRef(0);
  const [docNavigationMode, setDocNavigationMode] = useState<"resume" | "direct-row" | "switch">(
    rowIdParam ? "direct-row" : "resume",
  );
  // 每个文档/深链行只恢复一次位置，避免编辑刷新后反复抢滚动（item 4 行级增强）。
  const restoredDocRef = useRef<string | null>(null);
  // 每个文档只打一次处理计时起点（task 1）。
  const reviewStartedDocs = useRef<Set<string>>(new Set());
  // 列显示偏好：被隐藏的字段列 key 集合，持久化到 localStorage。
  const [hiddenFieldKeys, setHiddenFieldKeys] = useState<Set<string>>(new Set());
  // 单行数据定位开关：开=点击/悬停行可在原图定位并高亮，关=纯查看不联动、原图不画框。
  const [locateEnabled, setLocateEnabled] = useState(true);
  // 列宽（item 2）：字段 key → 用户拖拽设定的像素宽度，持久化到 localStorage。
  const [colWidths, setColWidths] = useState<Record<string, number>>({});
  const widthsHydrated = useRef(false);
  const resizing = useRef<{ key: string; startX: number; startW: number } | null>(null);
  // 上次审核到的文档（item 4）：按作用域记忆，进入时定位到此而非第一张。
  const [storedLastId, setStoredLastId] = useState<string | null>(null);

  // 挂载后读取持久化偏好（初值取默认，避免 SSR/CSR 水合不一致）。
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const rawCols = window.localStorage.getItem("review-hidden-cols");
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 挂载后读取持久化偏好，水合安全
      if (rawCols) setHiddenFieldKeys(new Set(JSON.parse(rawCols) as string[]));
      const rawWidths = window.localStorage.getItem("review-col-widths");
      if (rawWidths) setColWidths(JSON.parse(rawWidths) as Record<string, number>);
    } catch {
      /* 忽略损坏的本地偏好 */
    }
    widthsHydrated.current = true;
    if (window.localStorage.getItem("review-locate-enabled") === "0") {
      setLocateEnabled(false);
    }
  }, []);

  function toggleColumn(key: string) {
    setHiddenFieldKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      if (typeof window !== "undefined")
        window.localStorage.setItem("review-hidden-cols", JSON.stringify([...next]));
      return next;
    });
  }

  function toggleLocate() {
    setLocateEnabled((prev) => {
      const next = !prev;
      if (typeof window !== "undefined")
        window.localStorage.setItem("review-locate-enabled", next ? "1" : "0");
      return next;
    });
  }

  // 列宽拖拽（item 2）：按下记录起始宽度，移动实时更新，松手结束；通过 pointer capture
  // 让拖到表头外也持续响应。持久化由下方 effect 跟随 colWidths 写入。
  function startResize(event: React.PointerEvent, key: string) {
    const th = event.currentTarget.parentElement as HTMLElement | null;
    const startW = th?.getBoundingClientRect().width ?? 120;
    resizing.current = { key, startX: event.clientX, startW };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }
  function moveResize(event: React.PointerEvent) {
    const state = resizing.current;
    if (!state) return;
    const next = Math.max(60, Math.min(640, Math.round(state.startW + (event.clientX - state.startX))));
    setColWidths((prev) => ({ ...prev, [state.key]: next }));
  }
  function endResize(event: React.PointerEvent) {
    if (!resizing.current) return;
    resizing.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* 指针已释放 */
    }
  }
  // 双击手柄：清除该列的手动宽度，恢复按内容自适应（item 2 增强）。
  function resetColumn(key: string) {
    setColWidths((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  const resizeHandle = (key: string) => (
    <span
      onPointerDown={(event) => startResize(event, key)}
      onPointerMove={moveResize}
      onPointerUp={endResize}
      onDoubleClick={() => resetColumn(key)}
      className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize touch-none select-none hover:bg-primary/40"
      title="拖拽调整列宽，双击恢复自适应"
    />
  );

  // 持久化列宽（item 2）：水合完成后跟随 colWidths 写入；水合前不写，避免空值覆盖已存偏好。
  useEffect(() => {
    if (!widthsHydrated.current || typeof window === "undefined") return;
    try {
      window.localStorage.setItem("review-col-widths", JSON.stringify(colWidths));
    } catch {
      /* 忽略写入失败 */
    }
  }, [colWidths]);

  // 读取「上次审核到的文档」（item 4）。用全局键（跨作用域稳定），挂载时读取一次。
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const value = window.localStorage.getItem("review-last-doc");
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 挂载后读取持久化偏好，水合安全
      setStoredLastId(value && value.length ? value : null);
    } catch {
      /* 忽略损坏的本地偏好 */
    }
  }, []);
  // 顶部文件条：左右拖拽横向滚动。moved 标记用于区分「拖拽」与「点击选中」，避免拖动时误选文件。
  const stripRef = useRef<HTMLDivElement | null>(null);
  const stripDrag = useRef({ active: false, startX: 0, scrollLeft: 0, moved: false });

  function onStripPointerDown(event: React.PointerEvent) {
    const el = stripRef.current;
    if (!el) return;
    stripDrag.current = { active: true, startX: event.clientX, scrollLeft: el.scrollLeft, moved: false };
  }
  function onStripPointerMove(event: React.PointerEvent) {
    const el = stripRef.current;
    if (!el || !stripDrag.current.active) return;
    const dx = event.clientX - stripDrag.current.startX;
    if (Math.abs(dx) > 4) stripDrag.current.moved = true;
    el.scrollLeft = stripDrag.current.scrollLeft - dx;
  }
  function endStripDrag() {
    stripDrag.current.active = false;
  }

  // 作用域随 URL 切换时同步选中文档：带 documentId 深链则定位之，否则回到列表首项（清空旧批次的陈旧选中）。
  // render 阶段调整状态，优于 effect：避免跨批次陈旧 documentId 的一帧闪烁。
  const urlScopeKey = `${batchIdParam ?? ""}|${documentIdParam ?? ""}|${rowIdParam ?? ""}`;
  const [prevScopeKey, setPrevScopeKey] = useState(urlScopeKey);
  if (prevScopeKey !== urlScopeKey) {
    setPrevScopeKey(urlScopeKey);
    setOverride(documentIdParam);
    setOverrideRowId(rowIdParam);
    setDocNavigationMode(rowIdParam ? "direct-row" : "resume");
  }

  // 持久化"上次审核到的文档"（item 4，全局键）。只在用户显式选择/导航/编辑时写，
  // 不在初次自动选中第一张时写，避免覆盖掉真正的上次位置。
  function rememberDoc(id: string | null) {
    if (typeof window === "undefined" || !id) return;
    try {
      window.localStorage.setItem("review-last-doc", id);
    } catch {
      /* 忽略写入失败 */
    }
  }

  function scrollToReviewTop() {
    requestAnimationFrame(() => {
      pageTopRef.current?.scrollIntoView({ block: "start" });
    });
  }

  function selectDoc(id: string, options?: { rowId?: string | null; restoreSavedRow?: boolean }) {
    rememberDoc(id);
    const rowId = options?.rowId ?? null;
    setDocNavigationMode(rowId ? "direct-row" : options?.restoreSavedRow ? "resume" : "switch");
    setOverride(id);
    setOverrideRowId(rowId);
    scrollToReviewTop();
  }

  // 跨批次/单批次文档待办列表（审核数据通路）：无 batchId=全部，带 batchId=隔离到该批次。
  const { data: docList } = useQuery<{ documents: WorklistDoc[] }>({
    queryKey: ["documents", batchIdParam ?? "all"],
    queryFn: () =>
      apiGet(batchIdParam ? `${apiPaths.documents}?batchId=${batchIdParam}` : apiPaths.documents),
  });
  const documents = useMemo(() => docList?.documents ?? [], [docList]);

  // 词语联想数据源（item 1）：从资料库取商品名/单位候选，供 <datalist> 输入联想。
  const { data: suggestData } = useQuery<{
    codes: string[];
    names: string[];
    units: string[];
    unitByName: Record<string, string>;
    namesByCode: Record<string, Array<{ value: string; count: number }>>;
    codesByName: Record<string, Array<{ value: string; count: number }>>;
    nameCorrections: Record<string, string>;
    library: Array<{ name: string; unit: string | null; price: number | null }>;
  }>({
    queryKey: ["suggest"],
    queryFn: () => apiGet(apiPaths.suggest),
    staleTime: 60_000,
  });
  const suggestCodes = suggestData?.codes ?? [];
  const suggestNames = suggestData?.names ?? [];
  const suggestUnits = suggestData?.units ?? [];
  const unitByName = useMemo(() => suggestData?.unitByName ?? {}, [suggestData]);
  const namesByCode = useMemo(() => suggestData?.namesByCode ?? {}, [suggestData]);
  const codesByName = useMemo(() => suggestData?.codesByName ?? {}, [suggestData]);
  const nameCorrections = useMemo(() => suggestData?.nameCorrections ?? {}, [suggestData]);
  // 产品库预归一化（一次），供模糊匹配建议复用，避免逐行重复归一。
  const matchLibrary = useMemo(
    () =>
      (suggestData?.library ?? []).map((product) => ({ ...product, norm: normalizeMatchKey(product.name) })),
    [suggestData],
  );

  const normKey = (value: string) =>
    String(value ?? "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/\s+/g, "")
      .trim();

  const normalizeCodeKey = (value: string | null | undefined) =>
    String(value ?? "")
      .normalize("NFKC")
      .trim();

  const pairHint = (source: string, count: number) => (count > 0 ? `${source}×${count}` : "库");

  // 单位联想按当前行商品名给候选（task 2）：命中产品库 → 该产品单位置顶；未命中 → 用全局单位列表。
  function unitOptionsForRow(row: ApiRow): string[] | undefined {
    const matched = unitByName[normKey(row.name)];
    if (!matched) return undefined;
    return [matched, ...suggestUnits.filter((unit) => unit !== matched)];
  }

  function codeOptionsForRow(row: ApiRow): string[] | undefined {
    const matched = codesByName[normKey(row.name)]?.map((item) => item.value) ?? [];
    if (!matched.length) return undefined;
    return [...matched, ...suggestCodes.filter((code) => !matched.includes(code))];
  }

  // 隔离模式取批次头信息（名称/审批模式）；全部模式无单一批次。
  const { data: batchDetail } = useQuery<{ batch: { id: string; name: string; approvalMode: string } }>({
    queryKey: ["batch", batchIdParam],
    queryFn: () => apiGet(apiPaths.batch(batchIdParam as string)),
    enabled: Boolean(batchIdParam),
  });

  const filteredDocs = useMemo(
    () =>
      documents.filter((doc) => {
        const matchesSearch = docSearch
          ? doc.originalName.toLowerCase().includes(docSearch.toLowerCase())
          : true;
        const matchesFilter = docFilter === "all" ? true : doc.reviewState === docFilter;
        const matchesTriage = triageFilter === "all" ? true : docQueue(doc) === triageFilter;
        return matchesSearch && matchesFilter && matchesTriage;
      }),
    [documents, docSearch, docFilter, triageFilter],
  );

  // item 4：无显式选择/深链时，优先回到该作用域上次审核到的文档（仍存在才用），否则第一张。
  const fallbackDocId =
    (storedLastId && documents.some((doc) => doc.id === storedLastId) ? storedLastId : documents[0]?.id) ??
    null;
  const selectedId = override ?? fallbackDocId;
  const [prevSelectedId, setPrevSelectedId] = useState(selectedId);
  if (prevSelectedId !== selectedId) {
    setPrevSelectedId(selectedId);
    setActiveRowId(null);
    setTargetRowId(null);
    setShortCodeScanActive(false);
  }
  const selectedDoc = documents.find((doc) => doc.id === selectedId) ?? null;
  // 导航在「当前过滤列表」内迭代（全部/隔离统一）。
  const selectedIndex = filteredDocs.findIndex((doc) => doc.id === selectedId);
  // 列与审核动作按所选文档所属批次解析（全部模式每文档单场景，无错位）。
  const activeDocBatchId = selectedDoc?.batchId ?? batchIdParam ?? undefined;

  const { data: docData, isLoading } = useQuery<{ document: ApiDocument }>({
    queryKey: ["document", selectedId],
    queryFn: () => apiGet(apiPaths.document(selectedId as string)),
    enabled: Boolean(selectedId),
  });

  const document = docData?.document;
  // 用 useMemo 稳定 rows 引用：避免每次渲染产生新数组，触发依赖它的 effect/useMemo 反复执行。
  const rows = useMemo(() => document?.rows ?? [], [document]);
  const documentTriage = document?.triage;
  const rowTriageById = useMemo(() => new Map(rows.map((row) => [row.id, row.triage ?? null])), [rows]);
  const issueRows = useMemo(
    () => rows.filter((row) => (row.fieldIssues?.length ?? row.triage?.fieldIssues.length ?? 0) > 0),
    [rows],
  );
  const activeRow = useMemo(() => rows.find((row) => row.id === activeRowId) ?? null, [rows, activeRowId]);
  const shortCodeRows = useMemo(() => rows.filter((row) => isShortProductCode(row.code)), [rows]);
  const shortCodeRowIds = useMemo(() => new Set(shortCodeRows.map((row) => row.id)), [shortCodeRows]);
  const rowReasonsById = useMemo(
    () => new Map(rows.map((row) => [row.id, safeParseStringArray(row.riskReasonsJson)])),
    [rows],
  );
  const pairHealthByRow = useMemo(() => {
    const mismatch = new Set<string>();
    const minority = new Set<string>();

    for (const row of rows) {
      const nameKey = normKey(row.name);
      const codeKey = normalizeCodeKey(row.code);
      if (!nameKey || !codeKey) continue;

      const nameCandidates = namesByCode[codeKey] ?? [];
      const codeCandidates = codesByName[nameKey] ?? [];
      const matchedName = nameCandidates.find((item) => normKey(item.value) === nameKey);
      const matchedCode = codeCandidates.find((item) => normalizeCodeKey(item.value) === codeKey);

      if ((nameCandidates.length && !matchedName) || (codeCandidates.length && !matchedCode)) {
        mismatch.add(row.id);
      }

      const maxNameCount = Math.max(0, ...nameCandidates.map((item) => item.count));
      const maxCodeCount = Math.max(0, ...codeCandidates.map((item) => item.count));
      if (matchedName && maxNameCount > 0 && matchedName.count < maxNameCount) minority.add(row.id);
      if (matchedCode && maxCodeCount > 0 && matchedCode.count < maxCodeCount) minority.add(row.id);
    }

    return { mismatch, minority };
  }, [rows, namesByCode, codesByName]);
  const pairMismatchRowIds = pairHealthByRow.mismatch;
  const pairMinorityRowIds = pairHealthByRow.minority;
  const nameMultiCodeRows = useMemo(
    () => rows.filter((row) => rowReasonsById.get(row.id)?.includes("NAME_MULTI_CODE")),
    [rows, rowReasonsById],
  );
  const nameMultiCodeRowIds = useMemo(
    () => new Set(nameMultiCodeRows.map((row) => row.id)),
    [nameMultiCodeRows],
  );
  const codeNameConflictRows = useMemo(
    () => rows.filter((row) => rowReasonsById.get(row.id)?.includes("CODE_NAME_CONFLICT")),
    [rows, rowReasonsById],
  );
  const codeNameConflictRowIds = useMemo(
    () => new Set(codeNameConflictRows.map((row) => row.id)),
    [codeNameConflictRows],
  );

  // 产品库模糊匹配候选（带置信度）：仅对未审核行算，结果随 rows / 产品库变化缓存（前端计算，不拖慢确认）。
  const libraryCandidatesByRow = useMemo(() => {
    const map = new Map<string, NameCandidate[]>();
    if (!matchLibrary.length) return map;
    for (const row of rows) {
      if (row.status === "confirmed") continue;
      const candidates = matchLibraryCandidates(
        { name: row.name, unit: row.unit, price: row.price },
        matchLibrary,
      );
      if (candidates.length) map.set(row.id, candidates);
    }
    return map;
  }, [rows, matchLibrary]);

  // 单元格一键候选小标：名称列给「产品库匹配(带置信度) + 副模型候选 + 历史纠正」；单位列给产品库单位。
  function cellSuggestions(
    row: ApiRow,
    field: FieldDef,
  ): Array<{ value: string; hint?: string }> | undefined {
    if (field.key === "name") {
      const out: Array<{ value: string; hint?: string }> = [];
      for (const candidate of namesByCode[normalizeCodeKey(row.code)] ?? []) {
        out.push({ value: candidate.value, hint: pairHint("编码", candidate.count) });
      }
      // 产品库匹配保留置信度%；副模型候选、历史纠正只显示候选词本身（去掉来源标签，更清爽）。
      for (const candidate of libraryCandidatesByRow.get(row.id) ?? []) {
        out.push({ value: candidate.name, hint: `${candidate.confidence}%` });
      }
      if (row.altName) out.push({ value: row.altName });
      const corr = nameCorrections[normKey(row.name)];
      if (corr) out.push({ value: corr });
      return out.length ? out : undefined;
    }
    if (field.key === "unit") {
      const matched = unitByName[normKey(row.name)];
      return matched ? [{ value: matched, hint: "库" }] : undefined;
    }
    if (field.key === "code") {
      const candidates = codesByName[normKey(row.name)] ?? [];
      return candidates.length
        ? candidates.map((candidate) => ({ value: candidate.value, hint: pairHint("名称", candidate.count) }))
        : undefined;
    }
    return undefined;
  }
  const imageRegions = useMemo<ImageRegion[]>(
    () =>
      rows
        .map((row, index): ImageRegion | null => {
          const box = rowSourceRegion(row);
          if (!box) return null;
          return {
            id: row.id,
            label: `第 ${index + 1} 行 ${row.name}`,
            box,
            tone: row.auditState === "flagged" ? "flagged" : "active",
          };
        })
        .filter((region): region is ImageRegion => region !== null),
    [rows],
  );

  const fieldSchema = useFieldSchema({ batchId: activeDocBatchId });
  // 加载前用默认场景字段兜底，避免列结构跳变。
  const fields = fieldSchema.data?.fields ?? getScenarioFields(DEFAULT_SCENARIO_ID);
  // 应用「列显示」勾选，并把备注列后移到「标识类别」之后，让人工核对标识在首屏内可见。
  const visibleFields = useMemo(
    () => fields.filter((field) => !hiddenFieldKeys.has(field.key)),
    [fields, hiddenFieldKeys],
  );
  const remarkField = useMemo(
    () => visibleFields.find((field) => field.key === "remark") ?? null,
    [visibleFields],
  );
  const mainFields = useMemo(() => visibleFields.filter((field) => field.key !== "remark"), [visibleFields]);

  const bulkScope = selectedId
    ? `${apiPaths.reviewBulkSuggestions}?documentId=${selectedId}`
    : activeDocBatchId
      ? `${apiPaths.reviewBulkSuggestions}?batchId=${activeDocBatchId}`
      : apiPaths.reviewBulkSuggestions;
  const { data: bulkSuggestionData } = useQuery<{ suggestions: BulkSuggestion[] }>({
    queryKey: ["review-bulk-suggestions", selectedId, activeDocBatchId],
    queryFn: () => apiGet(bulkScope),
    enabled: Boolean(selectedId || activeDocBatchId),
  });
  const bulkSuggestions = bulkSuggestionData?.suggestions ?? [];

  function fieldIssues(row: ApiRow, field: FieldDef): ReviewFieldIssue[] {
    const issues = [...(row.fieldIssues ?? row.triage?.fieldIssues ?? [])].filter((item) => item.field === field.key);
    if (field.key === "name") {
      const candidate = libraryCandidatesByRow.get(row.id)?.find((item) => item.confidence >= 85);
      if (candidate && normKey(candidate.name) !== normKey(row.name)) {
        issues.push({
          field: "name",
          code: "PRODUCT_LIBRARY_CANDIDATE",
          severity: "info",
          message: `产品库高置信候选：${candidate.name}`,
          action: "use_candidate_name",
          suggestion: candidate.name,
        });
      }
    }
    if (field.key === "code") {
      const candidate = codesByName[normKey(row.name)]?.[0]?.value;
      if (candidate && normalizeCodeKey(candidate) !== normalizeCodeKey(row.code)) {
        issues.push({
          field: "code",
          code: "PRODUCT_CODE_CANDIDATE",
          severity: "info",
          message: `产品库/历史建议编码：${candidate}`,
          action: "use_candidate_code",
          suggestion: candidate,
        });
      }
    }
    if (field.key === "unit") {
      const candidate = unitByName[normKey(row.name)];
      if (candidate && candidate !== String(row.unit ?? "").trim()) {
        issues.push({
          field: "unit",
          code: "PRODUCT_UNIT_CANDIDATE",
          severity: "info",
          message: `产品库建议单位：${candidate}`,
          action: "use_candidate_unit",
          suggestion: candidate,
        });
      }
    }
    return issues;
  }

  function issueTone(issues: ReviewFieldIssue[]): "danger" | "warning" | "info" | undefined {
    if (issues.some((item) => item.severity === "danger")) return "danger";
    if (issues.some((item) => item.severity === "warning")) return "warning";
    if (issues.some((item) => item.severity === "info")) return "info";
    return undefined;
  }

  useEffect(() => {
    rowRefs.current = {};
  }, [selectedId]);

  function nextTargetRegionId(rowId: string, reason: string) {
    targetSequence.current += 1;
    return `${rowId}:${reason}:${targetSequence.current}`;
  }

  // item 4：初次定位到上次审核的文档后，把待办列表翻到它所在页，避免停在第一页看不到当前单据。
  const pagedToResumeRef = useRef(false);
  useEffect(() => {
    if (pagedToResumeRef.current || selectedIndex < 0) return;
    pagedToResumeRef.current = true;
    setDocPage(Math.floor(selectedIndex / DOC_PAGE_SIZE) + 1);
  }, [selectedIndex]);

  // task 1：首次打开某单据时打处理计时起点（fire-and-forget，服务端 set-once）。
  useEffect(() => {
    if (!selectedId || reviewStartedDocs.current.has(selectedId)) return;
    reviewStartedDocs.current.add(selectedId);
    apiJson(apiPaths.documentReviewStart(selectedId), { method: "POST" }).catch(() => {
      /* 计时起点失败不影响审核 */
    });
  }, [selectedId]);

  // item 4 行级增强：文档打开且行加载后，滚动定位到上次审核到的行并高亮（每个文档仅一次）。
  useEffect(() => {
    const restoreKey = `${selectedId ?? ""}:${overrideRowId ?? ""}:${docNavigationMode}`;
    if (!selectedId || rows.length === 0 || restoredDocRef.current === restoreKey) return;
    restoredDocRef.current = restoreKey;
    if (overrideRowId && rows.some((row) => row.id === overrideRowId)) {
      const target = overrideRowId;
      requestAnimationFrame(() => {
        rowRefs.current[target]?.scrollIntoView({ block: "center" });
        setActiveRowId(target);
        setTargetRowId(nextTargetRegionId(target, "direct"));
      });
      return;
    }
    if (docNavigationMode === "switch") return;
    let rowId: string | null = null;
    try {
      rowId =
        typeof window !== "undefined" ? window.localStorage.getItem(`review-last-row:${selectedId}`) : null;
    } catch {
      rowId = null;
    }
    if (!rowId || !rows.some((row) => row.id === rowId)) return;
    const target = rowId;
    requestAnimationFrame(() => {
      rowRefs.current[target]?.scrollIntoView({ block: "center" });
      setActiveRowId(target);
    });
  }, [selectedId, overrideRowId, rows, docNavigationMode]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["document", selectedId] });
    queryClient.invalidateQueries({ queryKey: ["documents"] });
    if (selectedDoc?.batchId) queryClient.invalidateQueries({ queryKey: ["batch", selectedDoc.batchId] });
    queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  };

  const confirmRows = useMutation({
    mutationFn: (payload: { rowIds?: string[]; documentId?: string }) =>
      apiJson(apiPaths.rowsBulkConfirm, { method: "POST", body: JSON.stringify(payload) }),
    onSuccess: invalidate,
  });

  const autoPassDocument = useMutation({
    mutationFn: (documentId: string) => apiJson(apiPaths.documentAutoPass(documentId), { method: "POST" }),
    onSuccess: invalidate,
  });

  const applyBulkSuggestion = useMutation({
    mutationFn: (suggestion: BulkSuggestion) =>
      apiJson(apiPaths.reviewBulkSuggestionsApply, {
        method: "POST",
        body: JSON.stringify(suggestion),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["review-bulk-suggestions"] });
      invalidate();
    },
  });

  const clearShortCodes = useMutation({
    mutationFn: (payload: { rowIds: string[]; documentId?: string }) =>
      apiJson(apiPaths.rowsClearShortCodes, { method: "POST", body: JSON.stringify(payload) }),
    onSuccess: () => {
      setShortCodeScanActive(false);
      invalidate();
    },
  });

  const updateRow = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) =>
      apiJson(apiPaths.row(id), { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: invalidate,
  });

  const deleteRow = useMutation({
    mutationFn: (id: string) => apiJson(apiPaths.row(id), { method: "DELETE" }),
    onSuccess: () => {
      setDeletingId(null);
      invalidate();
    },
  });

  const createRow = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      apiJson(apiPaths.rows, { method: "POST", body: JSON.stringify(payload) }),
    onSuccess: () => {
      setDraftAfterId(undefined);
      invalidate();
    },
  });

  // 保存草稿行：按 field-schema 拆分核心列 / extra 列，afterRowId 决定插入位置（null=末尾）。
  function saveDraft(values: Record<string, string>) {
    if (!selectedId) return;
    const core: Record<string, unknown> = {};
    const extra: Record<string, unknown> = {};
    for (const field of fields) {
      if (!field.editable) continue;
      const raw = values[field.key] ?? "";
      const value = field.type === "number" ? Number(raw || 0) : raw;
      if (isCoreColumn(field.key)) core[field.key] = value;
      else extra[field.key] = value;
    }
    createRow.mutate({
      documentId: selectedId,
      afterRowId: draftAfterId ?? null,
      ...core,
      ...(Object.keys(extra).length ? { extra } : {}),
    });
  }

  function commitField(id: string, field: FieldDef, raw: string) {
    rememberRow(id);
    const value = field.type === "number" ? Number(raw || 0) : raw;
    const patch = isCoreColumn(field.key) ? { [field.key]: value } : { extra: { [field.key]: value } };
    updateRow.mutate({ id, patch });
  }

  function scanShortCodes() {
    if (!shortCodeRows.length) {
      setShortCodeScanActive(false);
      if (typeof window !== "undefined") window.alert("当前页没有少于 3 位的商品编码。");
      return;
    }
    setShortCodeScanActive(true);
    const first = shortCodeRows[0];
    setActiveRowId(first.id);
    setTargetRowId(nextTargetRegionId(first.id, "short-code"));
    requestAnimationFrame(() =>
      rowRefs.current[first.id]?.scrollIntoView({ block: "center", behavior: "smooth" }),
    );
  }

  function clearCurrentPageShortCodes() {
    if (!selectedId || !shortCodeRows.length) return;
    setShortCodeScanActive(true);
    const rowIds = shortCodeRows.map((row) => row.id);
    const confirmed =
      typeof window === "undefined" ||
      window.confirm(`确认清除当前页 ${rowIds.length} 行少于 3 位的商品编码？正常编码不会被修改。`);
    if (!confirmed) return;
    clearShortCodes.mutate({ documentId: selectedId, rowIds });
  }

  function jumpToIssue(offset = 1) {
    if (!issueRows.length) return;
    const current = activeRowId ? issueRows.findIndex((row) => row.id === activeRowId) : -1;
    const next = issueRows[(current + offset + issueRows.length) % issueRows.length];
    if (!next) return;
    setActiveRowId(next.id);
    if (rowSourceRegion(next)) setTargetRowId(nextTargetRegionId(next.id, "issue"));
    requestAnimationFrame(() => rowRefs.current[next.id]?.scrollIntoView({ block: "center", behavior: "smooth" }));
  }

  // 运行审核是批次级动作：作用于当前所选文档所属批次（全部/隔离统一）。
  const runAudit = useMutation({
    mutationFn: () => apiJson(apiPaths.batchAudit(activeDocBatchId as string), { method: "POST" }),
    onSuccess: invalidate,
  });

  function adoptSuggestion(row: ApiRow) {
    if (!row.auditSuggestionJson) return;
    try {
      const s = JSON.parse(row.auditSuggestionJson) as Partial<ApiRow>;
      updateRow.mutate({
        id: row.id,
        patch: {
          code: s.code ?? "",
          name: s.name,
          unit: s.unit ?? "",
          qty: s.qty,
          price: s.price,
          amount: s.amount,
        },
      });
    } catch {
      /* 建议值解析失败则忽略 */
    }
  }

  function goTo(offset: number) {
    if (selectedIndex < 0) return;
    const next = filteredDocs[selectedIndex + offset];
    if (next) selectDoc(next.id);
  }

  // 记住当前文档"审核到的行"（item 4 行级增强）：编辑/点击行时写入，下次打开滚动定位到此。
  function rememberRow(rowId: string) {
    if (typeof window === "undefined" || !selectedId) return;
    // 编辑/点击当前文档即视为"在审核它"，一并记住文档（即使没切换文档也能恢复到这里）。
    rememberDoc(selectedId);
    try {
      window.localStorage.setItem(`review-last-row:${selectedId}`, rowId);
    } catch {
      /* 忽略写入失败 */
    }
  }

  function locateRow(row: ApiRow) {
    if (!rowSourceRegion(row)) return;
    setActiveRowId(row.id);
    setTargetRowId(nextTargetRegionId(row.id, "locate"));
  }

  function clickRow(row: ApiRow, target: EventTarget | null) {
    rememberRow(row.id);
    if (!rowSourceRegion(row)) return;
    if (target instanceof HTMLElement && target.closest("button,input,select,textarea,a")) {
      setActiveRowId(row.id);
      return;
    }
    locateRow(row);
  }

  function selectRegion(rowId: string) {
    setActiveRowId(rowId);
    rowRefs.current[rowId]?.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  // 专注模式联动侧边栏：进入折叠、退出展开，给原图与明细让出横向空间。
  // 跳过首次挂载，避免覆盖用户在普通模式的折叠偏好；仅在用户切换专注态时联动。
  const focusInitRef = useRef(true);
  useEffect(() => {
    if (focusInitRef.current) {
      focusInitRef.current = false;
      return;
    }
    setCollapsed(focus);
  }, [focus, setCollapsed]);

  // 专注模式键盘导航：←/→ 切换单据，Esc 退出（在输入框/下拉里只处理 Esc，不拦截编辑）。
  useEffect(() => {
    if (!focus) return;
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable;
      if (event.key === "Escape") {
        setFocus(false);
        return;
      }
      if (typing) return;
      // 键盘切换也记住"上次审核到的文档"（直接写，避免把组件函数引入 effect 依赖）。
      const persist = (id: string) => {
        try {
          window.localStorage.setItem("review-last-doc", id);
        } catch {
          /* 忽略写入失败 */
        }
      };
      if (event.key === "ArrowLeft" && selectedIndex > 0) {
        event.preventDefault();
        const id = filteredDocs[selectedIndex - 1].id;
        persist(id);
        setDocNavigationMode("switch");
        setOverride(id);
        setOverrideRowId(null);
        scrollToReviewTop();
      } else if (event.key === "ArrowRight" && selectedIndex < filteredDocs.length - 1) {
        event.preventDefault();
        const id = filteredDocs[selectedIndex + 1].id;
        persist(id);
        setDocNavigationMode("switch");
        setOverride(id);
        setOverrideRowId(null);
        scrollToReviewTop();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focus, selectedIndex, filteredDocs]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable;
      if (typing) return;
      const key = event.key.toLowerCase();
      if (event.key === "Enter") {
        event.preventDefault();
        if (activeRow && activeRow.status !== "confirmed") {
          confirmRows.mutate({ rowIds: [activeRow.id] });
        } else if (selectedId && documentTriage?.autoPassEligible) {
          autoPassDocument.mutate(selectedId);
        }
      } else if (key === "a") {
        if (!selectedId || !documentTriage?.autoPassEligible) return;
        event.preventDefault();
        autoPassDocument.mutate(selectedId);
      } else if (key === "f") {
        if (!activeRow) return;
        event.preventDefault();
        if (rowSourceRegion(activeRow)) {
          setActiveRowId(activeRow.id);
          setTargetRowId(nextTargetRegionId(activeRow.id, "locate"));
        }
      } else if (key === "n") {
        event.preventDefault();
        if (selectedIndex >= 0) {
          const next = filteredDocs[selectedIndex + 1];
          if (next) {
            rememberDoc(next.id);
            setDocNavigationMode("switch");
            setOverride(next.id);
            setOverrideRowId(null);
            scrollToReviewTop();
          }
        }
      } else if (key === "p") {
        event.preventDefault();
        if (selectedIndex >= 0) {
          const prev = filteredDocs[selectedIndex - 1];
          if (prev) {
            rememberDoc(prev.id);
            setDocNavigationMode("switch");
            setOverride(prev.id);
            setOverrideRowId(null);
            scrollToReviewTop();
          }
        }
      } else if (key === "e") {
        event.preventDefault();
        if (!issueRows.length) return;
        const current = activeRowId ? issueRows.findIndex((row) => row.id === activeRowId) : -1;
        const next = issueRows[(current + 1 + issueRows.length) % issueRows.length];
        if (!next) return;
        setActiveRowId(next.id);
        if (rowSourceRegion(next)) setTargetRowId(nextTargetRegionId(next.id, "issue"));
        requestAnimationFrame(() =>
          rowRefs.current[next.id]?.scrollIntoView({ block: "center", behavior: "smooth" }),
        );
      } else if (event.key === "1") {
        event.preventDefault();
        setTriageFilter("manual");
        setDocPage(1);
      } else if (event.key === "2") {
        event.preventDefault();
        setTriageFilter("auto_pass");
        setDocPage(1);
      } else if (event.key === "3") {
        event.preventDefault();
        setTriageFilter("sample");
        setDocPage(1);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    activeRow,
    autoPassDocument,
    confirmRows,
    documentTriage,
    filteredDocs,
    activeRowId,
    issueRows,
    selectedId,
    selectedIndex,
  ]);

  const isAllScope = !batchIdParam;

  if (!documents.length) {
    return (
      <EmptyState
        batchId={batchIdParam ?? ""}
        message={
          isAllScope
            ? "暂无待审文档。请先创建批次并上传单据。"
            : "当前批次还没有文档，请先上传单据，或切换到「全部」查看其他批次。"
        }
      />
    );
  }

  const docTotalPages = Math.max(1, Math.ceil(filteredDocs.length / DOC_PAGE_SIZE));
  const safeDocPage = Math.min(docPage, docTotalPages);
  const pagedDocs = filteredDocs.slice((safeDocPage - 1) * DOC_PAGE_SIZE, safeDocPage * DOC_PAGE_SIZE);

  const riskReasons: string[] = (() => {
    try {
      return JSON.parse(document?.riskReasonsJson || "[]");
    } catch {
      return [];
    }
  })();

  return (
    <div ref={pageTopRef} className="space-y-4">
      {!focus && batchIdParam ? <BatchWorkspaceNav batchId={batchIdParam} active="review" /> : null}
      {focus ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface px-3 py-2">
          <div className="flex min-w-0 items-center gap-3">
            <Button
              size="sm"
              variant="secondary"
              className="text-[11px]"
              onClick={() => setFocus(false)}
              title="退出专注模式（Esc）"
            >
              <Minimize2 size={15} />
              退出
            </Button>
            <span className="truncate text-sm font-medium">{document?.originalName ?? "单据"}</span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {selectedIndex + 1} / {filteredDocs.length}
            </span>
            {document ? (
              <button
                type="button"
                onClick={() => setRiskOpen(true)}
                title="查看风险详情"
                className="shrink-0"
              >
                <RiskBadge risk={document.riskLevel} />
              </button>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="icon"
              variant="secondary"
              onClick={() => goTo(-1)}
              disabled={selectedIndex <= 0}
              title="上一张（←）"
            >
              <ChevronLeft size={15} />
            </Button>
            <select
              value={selectedId ?? ""}
              onChange={(event) => event.target.value && selectDoc(event.target.value)}
              className="h-8 max-w-48 rounded-md border border-border bg-surface px-2 text-xs outline-none focus:border-primary"
              title="快速跳转文件"
            >
              {filteredDocs.map((doc) => (
                <option key={doc.id} value={doc.id}>
                  {doc.originalName}
                </option>
              ))}
            </select>
            <Button
              size="icon"
              variant="secondary"
              onClick={() => goTo(1)}
              disabled={selectedIndex >= filteredDocs.length - 1}
              title="下一张（→）"
            >
              <ChevronRight size={15} />
            </Button>
            <Button
              size="sm"
              variant="secondary"
              className="text-[11px]"
              onClick={() => runAudit.mutate()}
              disabled={runAudit.isPending || !activeDocBatchId}
              title="对机器自动通过的行做二次复查（需 worker 运行）"
            >
              <ShieldCheck size={15} />
              复审
            </Button>
            <Button
              size="sm"
              variant="primary"
              className="text-[11px]"
              onClick={() => selectedId && autoPassDocument.mutate(selectedId)}
              disabled={autoPassDocument.isPending || !selectedId || !documentTriage?.autoPassEligible}
              title="当前单据满足低风险条件时一键通过（A）"
            >
              <Check size={15} />
              一键过
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold">审核工作台</h1>
              {batchDetail ? (
                <span className="text-sm text-muted-foreground">· {batchDetail.batch.name}</span>
              ) : (
                <span className="text-sm text-muted-foreground">· 全部</span>
              )}
              {batchDetail ? <ApprovalModeBadge mode={batchDetail.batch.approvalMode} /> : null}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <BatchScopeSelect batchId={batchIdParam ?? ""} />
            <Button
              size="sm"
              variant="secondary"
              className="text-[11px]"
              onClick={() => setFocus(true)}
              title="进入专注模式"
            >
              <Maximize2 size={15} />
              专注
            </Button>
            <Button
              size="icon"
              variant="secondary"
              onClick={() => goTo(-1)}
              disabled={selectedIndex <= 0}
              title="上一张"
            >
              <ChevronLeft size={15} />
            </Button>
            <Button
              size="icon"
              variant="secondary"
              onClick={() => goTo(1)}
              disabled={selectedIndex < 0 || selectedIndex >= filteredDocs.length - 1}
              title="下一张"
            >
              <ChevronRight size={15} />
            </Button>
            <Button
              size="sm"
              variant="secondary"
              className="text-[11px]"
              onClick={() => runAudit.mutate()}
              disabled={runAudit.isPending || !activeDocBatchId}
              title="对当前单据所属批次机器自动通过的行做二次复查（需 worker 运行）"
            >
              <ShieldCheck size={15} />
              复审
            </Button>
            <Button
              size="sm"
              variant="primary"
              className="text-[11px]"
              onClick={() => selectedId && autoPassDocument.mutate(selectedId)}
              disabled={autoPassDocument.isPending || !selectedId || !documentTriage?.autoPassEligible}
              title="当前单据满足低风险条件时一键通过（A）"
            >
              <Check size={15} />
              一键过
            </Button>
          </div>
        </div>
      )}

      {/* 文件条 —— 仅普通模式置于顶部，可左右拖拽横向滚动；专注模式用顶部精简控制条 + 快速跳转切换 */}
      {!focus ? (
        <Panel className="flex flex-col">
          <PanelHeader>
            <PanelTitle>文件</PanelTitle>
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex h-8 items-center gap-2 rounded-md border border-border bg-muted px-2 text-sm">
                <Search size={14} className="text-muted-foreground" />
                <input
                  value={docSearch}
                  onChange={(event) => {
                    setDocSearch(event.target.value);
                    setDocPage(1);
                  }}
                  placeholder="搜索文件名"
                  className="h-full w-40 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
                />
              </div>
              <div className="flex flex-wrap gap-1">
                {docFilters.map((filter) => (
                  <button
                    key={filter.key}
                    onClick={() => {
                      setDocFilter(filter.key);
                      setDocPage(1);
                    }}
                    className={`rounded-full border px-2.5 py-0.5 text-[11px] transition-colors ${
                      docFilter === filter.key
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-surface text-muted-foreground hover:bg-muted"
                    }`}
                  >
                    {filter.label}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap gap-1">
                {triageFilters.map((filter) => (
                  <button
                    key={filter.key}
                    onClick={() => {
                      setTriageFilter(filter.key);
                      setDocPage(1);
                    }}
                    className={`rounded-full border px-2.5 py-0.5 text-[11px] transition-colors ${
                      triageFilter === filter.key
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-surface text-muted-foreground hover:bg-muted"
                    }`}
                    title={filter.key === "all" ? undefined : `快捷键 ${filter.key === "manual" ? "1" : filter.key === "auto_pass" ? "2" : "3"}`}
                  >
                    {filter.label}
                  </button>
                ))}
              </div>
              <span className="text-xs text-muted-foreground">{filteredDocs.length} 个</span>
            </div>
          </PanelHeader>
          <div className="flex items-center gap-2 p-3">
            <button
              className="h-7 shrink-0 rounded border border-border bg-surface px-2 text-[11px] text-muted-foreground hover:bg-muted disabled:opacity-50"
              onClick={() => setDocPage((current) => Math.max(1, current - 1))}
              disabled={safeDocPage <= 1}
              title="上一页"
            >
              <ChevronLeft size={14} />
            </button>
            {pagedDocs.length ? (
              <div
                ref={stripRef}
                onPointerDown={onStripPointerDown}
                onPointerMove={onStripPointerMove}
                onPointerUp={endStripDrag}
                onPointerLeave={endStripDrag}
                className="flex flex-1 cursor-grab gap-2 overflow-x-auto pb-1 active:cursor-grabbing"
              >
                {pagedDocs.map((doc) => {
                  const badge = docStateBadge[doc.reviewState];
                  const triageBadge = queueBadge(docQueue(doc));
                  return (
                    <button
                      key={doc.id}
                      onClick={() => {
                        // 拖拽产生的位移不应触发选中（仅纯点击选中文件）。
                        if (stripDrag.current.moved) return;
                        selectDoc(doc.id);
                      }}
                      className={`w-56 shrink-0 rounded-md border px-2.5 py-2 text-left transition-colors ${
                        doc.id === selectedId
                          ? "border-primary bg-primary/5"
                          : "border-border bg-surface hover:bg-muted"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-xs font-medium">{doc.originalName}</span>
                        <div className="flex shrink-0 gap-1">
                          <Badge tone={triageBadge.tone}>{triageBadge.label}</Badge>
                          <Badge tone={badge.tone}>{badge.label}</Badge>
                        </div>
                      </div>
                      {/* 全部模式标注所属批次（收件箱式来源标签）；隔离模式同批次无需重复。 */}
                      {isAllScope ? (
                        <div className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
                          <Boxes size={11} className="shrink-0" />
                          <span className="truncate">{doc.batchName}</span>
                        </div>
                      ) : null}
                      <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                        <span>
                          {doc.rowStats.confirmed}/{doc.rowStats.total} 已确认
                        </span>
                        <RiskBadge risk={doc.riskLevel} />
                      </div>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="flex-1 px-2 py-4 text-center text-xs text-muted-foreground">
                没有符合条件的文档
              </div>
            )}
            <button
              className="h-7 shrink-0 rounded border border-border bg-surface px-2 text-[11px] text-muted-foreground hover:bg-muted disabled:opacity-50"
              onClick={() => setDocPage((current) => Math.min(docTotalPages, current + 1))}
              disabled={safeDocPage >= docTotalPages}
              title="下一页"
            >
              <ChevronRight size={14} />
            </button>
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {safeDocPage} / {docTotalPages}
            </span>
          </div>
        </Panel>
      ) : null}

      {documentTriage ? (
        <Panel className="px-3 py-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Badge tone={queueBadge(documentTriage.queue).tone}>
                {queueBadge(documentTriage.queue).label}
              </Badge>
              <span className="text-sm font-medium">
                {documentTriage.autoPassEligible ? "当前单据可一键通过" : "当前单据需要人工核对"}
              </span>
              <span className="text-xs text-muted-foreground">
                人工 {documentTriage.rowCounts.manual} · 可过 {documentTriage.rowCounts.autoPass} · 抽检 {documentTriage.rowCounts.sample}
              </span>
              {documentTriage.blockers.length ? (
                <span className="truncate text-xs text-muted-foreground" title={documentTriage.blockers.join("；")}>
                  阻断：{documentTriage.blockers.slice(0, 2).join("；")}
                </span>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                className="text-[11px]"
                onClick={() => jumpToIssue(1)}
                disabled={!issueRows.length}
                title="跳到下一个异常字段（E）"
              >
                <Search size={14} />
                下个异常
              </Button>
              <Button
                size="sm"
                variant="primary"
                className="text-[11px]"
                onClick={() => selectedId && autoPassDocument.mutate(selectedId)}
                disabled={autoPassDocument.isPending || !selectedId || !documentTriage.autoPassEligible}
                title="一键通过当前低风险单据（A）"
              >
                <Check size={14} />
                一键通过
              </Button>
            </div>
          </div>
        </Panel>
      ) : null}

      <div
        className={cn(
          "grid gap-4",
          focus
            ? // 专注模式固定视口高度（非 min-h），使两列等高、明细内部滚动、原图垂直居中；
              // 否则表格内容会撑开行高，导致 flex-1+overflow 失效（明细过长、原图被推到底部）。
              "h-[calc(100vh-9.5rem)] min-h-0 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]"
            : // 普通模式同样给定定高，使「原图」与「识别明细」两列左右等高对齐、明细内部滚动；
              // 识别尝试/风险详情移到整组下方，故此处只放这两列。
              "min-h-[560px] xl:h-[calc(100vh-15rem)] xl:min-h-0 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]",
        )}
      >
        {/* 列 1：原图预览（可缩放 + 拖拽平移） */}
        <Panel className="flex min-h-0 flex-col">
          {/* 原图表头保持紧凑，右侧明细工具栏自适应换行。 */}
          <PanelHeader className="h-14 shrink-0">
            <PanelTitle className="truncate">{document?.originalName ?? "单据预览"}</PanelTitle>
            {document ? <RiskBadge risk={document.riskLevel} /> : null}
          </PanelHeader>
          <ImageViewer
            className="flex-1"
            src={selectedId ? apiPaths.documentImage(selectedId) : null}
            alt={document?.originalName ?? "单据原图"}
            regions={locateEnabled ? imageRegions : []}
            activeRegionId={activeRowId}
            targetRegionId={targetRowId}
            onRegionSelect={selectRegion}
          />
        </Panel>

        <div className="flex min-h-0 min-w-0 flex-col">
          <Panel className="flex min-h-0 flex-1 flex-col">
            <PanelHeader className="min-h-16 shrink-0 flex-col items-stretch gap-2 py-2 lg:flex-row lg:items-center">
              <div className="flex min-w-0 items-center gap-2">
                <PanelTitle className="shrink-0">识别明细</PanelTitle>
                <span className="shrink-0 text-xs text-muted-foreground">{rows.length} 行</span>
                {shortCodeScanActive || shortCodeRows.length ? (
                  <Badge
                    tone={shortCodeRows.length ? "warning" : "success"}
                    className="h-5 px-1.5 text-[11px]"
                  >
                    短编码 {shortCodeRows.length}
                  </Badge>
                ) : null}
                {nameMultiCodeRows.length ? (
                  <Badge tone="warning" className="h-5 px-1.5 text-[11px]">
                    同名多码 {nameMultiCodeRows.length}
                  </Badge>
                ) : null}
                {codeNameConflictRows.length ? (
                  <Badge tone="danger" className="h-5 px-1.5 text-[11px]">
                    同码多品 {codeNameConflictRows.length}
                  </Badge>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                <ColumnMenu fields={fields} hidden={hiddenFieldKeys} onToggle={toggleColumn} />
                <Button
                  size="sm"
                  variant={locateEnabled ? "primary" : "secondary"}
                  className="text-[11px]"
                  onClick={toggleLocate}
                  title={
                    locateEnabled
                      ? "数据定位已开启：点击/悬停行可在原图定位高亮；点此关闭"
                      : "数据定位已关闭：点此开启，恢复点击行在原图定位"
                  }
                >
                  {locateEnabled ? <LocateFixed size={14} /> : <LocateOff size={14} />}定位
                </Button>
                <Button
                  size="sm"
                  variant={shortCodeScanActive ? "primary" : "secondary"}
                  className="text-[11px]"
                  onClick={scanShortCodes}
                  disabled={!rows.length}
                  title="识别当前页少于 3 位的商品编码并高亮定位"
                >
                  <Search size={14} />
                  短码
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  className="text-[11px]"
                  onClick={clearCurrentPageShortCodes}
                  disabled={!selectedId || !shortCodeRows.length || clearShortCodes.isPending}
                  title="清除当前页已识别出的少于 3 位商品编码"
                >
                  <Eraser size={14} />
                  {clearShortCodes.isPending ? "清除中..." : "清空"}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  className="text-[11px]"
                  onClick={() => setDraftAfterId(null)}
                  disabled={!selectedId || draftAfterId !== undefined}
                  title="在明细末尾新增一行（也可在某行右侧点「+」就近插入）"
                >
                  <Plus size={14} />
                  新增
                </Button>
              </div>
            </PanelHeader>
            <div className="min-h-0 flex-1 overflow-auto">
              <datalist id={SUGGEST_NAMES_ID}>
                {suggestNames.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
              <datalist id={SUGGEST_CODES_ID}>
                {suggestCodes.map((code) => (
                  <option key={code} value={code} />
                ))}
              </datalist>
              <datalist id={SUGGEST_UNITS_ID}>
                {suggestUnits.map((unit) => (
                  <option key={unit} value={unit} />
                ))}
              </datalist>
              {bulkSuggestions.length ? (
                <div className="border-b border-border bg-muted/40 px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium">批量建议</span>
                    {bulkSuggestions.slice(0, 4).map((suggestion) => (
                      <button
                        key={suggestion.id}
                        type="button"
                        onClick={() => {
                          const ok =
                            typeof window === "undefined" ||
                            window.confirm(`应用建议：${suggestion.title}？\n${suggestion.description}`);
                          if (ok) applyBulkSuggestion.mutate(suggestion);
                        }}
                        disabled={applyBulkSuggestion.isPending}
                        className={cn(
                          "inline-flex h-7 max-w-full items-center gap-1 rounded border px-2 text-[11px] hover:bg-surface disabled:opacity-60",
                          suggestion.severity === "danger" && "border-danger/30 bg-danger-soft text-danger-strong",
                          suggestion.severity === "warning" && "border-warning/30 bg-warning-soft text-warning-strong",
                          suggestion.severity === "info" && "border-info/30 bg-info-soft text-info-strong",
                        )}
                        title={suggestion.description}
                      >
                        <Wand2 size={13} />
                        <span className="truncate">{suggestion.title}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              <DataTable>
                <thead className={tableHeadClass}>
                  <tr>
                    <th className={tableCellClass}>行</th>
                    {mainFields.map((field) => (
                      <th
                        key={field.key}
                        className={cn(tableCellClass, "relative")}
                        style={
                          colWidths[field.key]
                            ? { width: colWidths[field.key], minWidth: colWidths[field.key] }
                            : undefined
                        }
                      >
                        {field.label}
                        {resizeHandle(field.key)}
                      </th>
                    ))}
                    <th className={tableCellClass}>状态</th>
                    <th className={tableCellClass}>标识类别</th>
                    {remarkField ? (
                      <th
                        className={cn(tableCellClass, "relative")}
                        style={
                          colWidths[remarkField.key]
                            ? { width: colWidths[remarkField.key], minWidth: colWidths[remarkField.key] }
                            : undefined
                        }
                      >
                        {remarkField.label}
                        {resizeHandle(remarkField.key)}
                      </th>
                    ) : null}
                    <th className={tableCellClass}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length ? (
                    rows.map((row, index) => {
                      const shortCodeMatched = shortCodeRowIds.has(row.id);
                      const nameMultiCodeMatched = nameMultiCodeRowIds.has(row.id);
                      const codeNameConflictMatched = codeNameConflictRowIds.has(row.id);
                      const pairMismatch = pairMismatchRowIds.has(row.id);
                      const pairMinority = pairMinorityRowIds.has(row.id);
                      const rowReasons = rowReasonsById.get(row.id) ?? [];
                      const rowTriage = rowTriageById.get(row.id);
                      return (
                        <Fragment key={row.id}>
                          <tr
                            ref={(node) => {
                              rowRefs.current[row.id] = node;
                            }}
                            className={cn(
                              "hover:bg-muted/40",
                              codeNameConflictMatched && "bg-danger-soft/50",
                              nameMultiCodeMatched && "bg-warning-soft/50",
                              pairMismatch && "bg-danger-soft/40",
                              pairMinority && "bg-warning-soft/60",
                              shortCodeScanActive && shortCodeMatched && "bg-danger-soft/60",
                              activeRowId === row.id && "bg-warning/10",
                            )}
                            onMouseEnter={() =>
                              locateEnabled && rowSourceRegion(row) && setActiveRowId(row.id)
                            }
                            onClick={(event) => locateEnabled && clickRow(row, event.target)}
                          >
                            <td className={tableCellClass}>
                              <div className="flex items-center gap-1.5">
                                <span>{index + 1}</span>
                                {shortCodeScanActive && shortCodeMatched ? (
                                  <Badge tone="warning" className="h-5 px-1.5 text-[10px]">
                                    短码
                                  </Badge>
                                ) : null}
                                {nameMultiCodeMatched ? (
                                  <Badge tone="warning" className="h-5 px-1.5 text-[10px]">
                                    多码
                                  </Badge>
                                ) : null}
                                {codeNameConflictMatched ? (
                                  <Badge tone="danger" className="h-5 px-1.5 text-[10px]">
                                    多品
                                  </Badge>
                                ) : null}
                                {pairMismatch ? (
                                  <Badge tone="danger" className="h-5 px-1.5 text-[10px]">
                                    校验
                                  </Badge>
                                ) : null}
                                {pairMinority ? (
                                  <Badge tone="warning" className="h-5 px-1.5 text-[10px]">
                                    少数
                                  </Badge>
                                ) : null}
                                {rowTriage ? (
                                  <Badge
                                    tone={queueBadge(rowTriage.queue).tone}
                                    className="h-5 px-1.5 text-[10px]"
                                  >
                                    {queueBadge(rowTriage.queue).label}
                                  </Badge>
                                ) : null}
                              </div>
                            </td>
                            {mainFields.map((field) => {
                              const issues = fieldIssues(row, field);
                              return (
                                <FieldCell
                                  key={field.key}
                                  value={rowFieldValue(row, field)}
                                  type={field.type === "number" ? "number" : "text"}
                                  align={field.align ?? (field.type === "number" ? "right" : "left")}
                                  disabled={!field.editable}
                                  widthClass={fieldCellWidthClass(field, true)}
                                  width={colWidths[field.key]}
                                  listId={fieldListId(field)}
                                  options={
                                    field.key === "unit"
                                      ? unitOptionsForRow(row)
                                      : field.key === "code"
                                        ? codeOptionsForRow(row)
                                        : undefined
                                  }
                                  suggestions={cellSuggestions(row, field)}
                                  issueTone={issueTone(issues)}
                                  issueTitle={issues.map((item) => item.message).join("；") || undefined}
                                  onCommit={(next) => commitField(row.id, field, next)}
                                />
                              );
                            })}
                            <td className={tableCellClass}>
                              <RowStatusBadge status={row.status} />
                            </td>
                            <td className={tableCellClass}>
                              <div className="flex flex-col items-start gap-1">
                                <ReviewClassBadge value={row.reviewClass} />
                                {row.auditState && row.auditState !== "none" ? (
                                  <span title={row.auditNote ?? undefined}>
                                    <AuditStateBadge value={row.auditState} />
                                  </span>
                                ) : null}
                                {rowReasons.length ? <ReasonList codes={rowReasons} emptyText="" /> : null}
                              </div>
                            </td>
                            {remarkField ? (
                              <FieldCell
                                value={rowFieldValue(row, remarkField)}
                                type={remarkField.type === "number" ? "number" : "text"}
                                align={
                                  remarkField.align ?? (remarkField.type === "number" ? "right" : "left")
                                }
                                disabled={!remarkField.editable}
                                widthClass={fieldCellWidthClass(remarkField)}
                                width={colWidths[remarkField.key]}
                                listId={fieldListId(remarkField)}
                                issueTone={issueTone(fieldIssues(row, remarkField))}
                                issueTitle={
                                  fieldIssues(row, remarkField).map((item) => item.message).join("；") ||
                                  undefined
                                }
                                onCommit={(next) => commitField(row.id, remarkField, next)}
                              />
                            ) : null}
                            <td className={tableCellClass}>
                              {deletingId === row.id ? (
                                <div className="flex items-center gap-1">
                                  <span className="text-[11px] text-danger-strong">删除此行？</span>
                                  <Button
                                    size="sm"
                                    variant="danger"
                                    className="text-[11px]"
                                    onClick={() => deleteRow.mutate(row.id)}
                                    disabled={deleteRow.isPending}
                                    title="确认删除（软删除，可在审计日志追溯）"
                                  >
                                    确认
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="text-[11px]"
                                    onClick={() => setDeletingId(null)}
                                    disabled={deleteRow.isPending}
                                  >
                                    取消
                                  </Button>
                                </div>
                              ) : (
                                <div className="flex gap-1">
                                  {locateEnabled && rowSourceRegion(row) ? (
                                    <Button
                                      size="icon"
                                      variant="ghost"
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        locateRow(row);
                                      }}
                                      title="在原图中定位此行"
                                    >
                                      <LocateFixed size={14} />
                                    </Button>
                                  ) : null}
                                  {row.auditState === "flagged" && row.auditSuggestionJson ? (
                                    <Button
                                      size="sm"
                                      variant="secondary"
                                      className="text-[11px]"
                                      onClick={() => adoptSuggestion(row)}
                                      disabled={updateRow.isPending}
                                      title={`采纳审核建议：${row.auditNote ?? ""}`}
                                    >
                                      <Wand2 size={14} />
                                      采纳
                                    </Button>
                                  ) : null}
                                  <Button
                                    size="sm"
                                    variant="secondary"
                                    className="text-[11px]"
                                    onClick={() => confirmRows.mutate({ rowIds: [row.id] })}
                                    disabled={confirmRows.isPending || row.status === "confirmed"}
                                  >
                                    确认
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => setDraftAfterId(row.id)}
                                    disabled={draftAfterId !== undefined}
                                    title="在此行下方插入新行"
                                  >
                                    <Plus size={14} />
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => setDeletingId(row.id)}
                                    title="删除此行"
                                  >
                                    <Trash2 size={14} />
                                  </Button>
                                </div>
                              )}
                            </td>
                          </tr>
                          {draftAfterId === row.id ? (
                            <DraftRow
                              mainFields={mainFields}
                              remarkField={remarkField}
                              isPending={createRow.isPending}
                              onSave={saveDraft}
                              onCancel={() => setDraftAfterId(undefined)}
                            />
                          ) : null}
                        </Fragment>
                      );
                    })
                  ) : draftAfterId === null ? null : (
                    <tr>
                      <td className={tableCellClass} colSpan={4 + visibleFields.length}>
                        <span className="text-muted-foreground">
                          {isLoading ? "加载中..." : "该文档暂无识别行"}
                        </span>
                      </td>
                    </tr>
                  )}
                  {draftAfterId === null ? (
                    <DraftRow
                      mainFields={mainFields}
                      remarkField={remarkField}
                      isPending={createRow.isPending}
                      onSave={saveDraft}
                      onCancel={() => setDraftAfterId(undefined)}
                    />
                  ) : null}
                </tbody>
              </DataTable>
            </div>
          </Panel>
        </div>
      </div>

      {/* 识别尝试 / 风险详情：移到原图+明细两列下方，整组底部并排展示（次要信息，不占首屏） */}
      {!focus ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel>
            <PanelHeader>
              <PanelTitle>识别尝试</PanelTitle>
              <span className="text-xs text-muted-foreground">{document?.attempts.length ?? 0} 次</span>
            </PanelHeader>
            <div className="divide-y divide-border">
              {document?.attempts.length ? (
                document.attempts.map((attempt) => (
                  <div key={attempt.id} className="flex items-center justify-between px-4 py-3 text-sm">
                    <div>
                      <div className="font-medium">
                        {attempt.providerKey}/{attempt.model}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        策略 {attempt.strategy} · {formatDateTime(attempt.completedAt ?? attempt.startedAt)}
                      </div>
                    </div>
                    <ModelErrorNote error={attempt.error} status={attempt.status} />
                  </div>
                ))
              ) : (
                <div className="px-4 py-6 text-sm text-muted-foreground">暂无识别尝试记录</div>
              )}
            </div>
          </Panel>

          <Panel>
            <PanelHeader>
              <PanelTitle>风险详情</PanelTitle>
              {document ? <RiskBadge risk={document.riskLevel} /> : null}
            </PanelHeader>
            <div className="space-y-2 p-4 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="shrink-0">风险原因：</span>
                <ReasonList codes={riskReasons} />
              </div>
              <Button size="sm" variant="primary" className="text-[11px]" onClick={() => setRiskOpen(true)}>
                说明
              </Button>
            </div>
          </Panel>
        </div>
      ) : null}
      <RiskDetailDrawer open={riskOpen} onClose={() => setRiskOpen(false)} reasons={riskReasons} />
    </div>
  );
}

function EmptyState({ batchId, message }: { batchId: string; message: string }) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">审核工作台</h1>
        <BatchScopeSelect batchId={batchId} />
      </div>
      <div className="rounded-lg border border-dashed border-border bg-surface px-4 py-16 text-center text-sm text-muted-foreground">
        {message}
      </div>
    </div>
  );
}

/**
 * 内联新增草稿行：按 field-schema 渲染可编辑字段，本地 state 驱动。
 * 商品名称（name）为必填，未填时禁用保存（与 validateRow 的 INVALID_PRODUCT_NAME 规则一致）。
 * 列结构与明细表对齐：行号 + 主字段 + 状态/标识类别（合并占位）+ 备注（如显示）+ 操作。
 */
function DraftRow({
  mainFields,
  remarkField,
  isPending,
  onSave,
  onCancel,
}: {
  mainFields: FieldDef[];
  remarkField: FieldDef | null;
  isPending: boolean;
  onSave: (values: Record<string, string>) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const nameFilled = (values.name ?? "").trim().length > 0;
  const renderInput = (field: FieldDef, compact: boolean) => (
    <td key={field.key} className={cn(tableCellClass, "p-1")}>
      {field.editable ? (
        <input
          type={field.type === "number" ? "number" : "text"}
          step={field.type === "number" ? "any" : undefined}
          list={
            field.key === "code"
              ? SUGGEST_CODES_ID
              : field.key === "name"
                ? SUGGEST_NAMES_ID
                : field.key === "unit"
                  ? SUGGEST_UNITS_ID
                  : undefined
          }
          value={values[field.key] ?? ""}
          onChange={(event) => setValues((prev) => ({ ...prev, [field.key]: event.target.value }))}
          placeholder={field.label}
          autoFocus={field.key === "name"}
          className={cn(
            "h-7 w-full rounded border border-border bg-background px-2 text-xs outline-none focus:border-primary",
            fieldCellWidthClass(field, compact),
            (field.align ?? (field.type === "number" ? "right" : "left")) === "right" && "text-right",
          )}
        />
      ) : (
        <span className="text-muted-foreground">-</span>
      )}
    </td>
  );
  return (
    <tr className="bg-primary/5">
      <td className={tableCellClass}>
        <span className="inline-flex items-center rounded bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground">
          新
        </span>
      </td>
      {mainFields.map((field) => renderInput(field, true))}
      <td className={tableCellClass} colSpan={2}>
        <span className="text-[11px] text-muted-foreground">待保存</span>
      </td>
      {remarkField ? renderInput(remarkField, false) : null}
      <td className={tableCellClass}>
        <div className="flex gap-1">
          <Button
            size="sm"
            variant="primary"
            className="text-[11px]"
            onClick={() => onSave(values)}
            disabled={isPending || !nameFilled}
            title={nameFilled ? "保存新行" : "请先填写商品名称"}
          >
            <Check size={14} />
            保存
          </Button>
          <Button size="sm" variant="ghost" className="text-[11px]" onClick={onCancel} disabled={isPending}>
            <X size={14} />
            取消
          </Button>
        </div>
      </td>
    </tr>
  );
}

/**
 * 列显示菜单：勾选/取消勾选明细表的字段列（如隐藏「商品编码」「单价」「金额」）。
 * 选择持久化在父组件并写入 localStorage；点击外部自动收起。
 */
function ColumnMenu({
  fields,
  hidden,
  onToggle,
}: {
  fields: FieldDef[];
  hidden: Set<string>;
  onToggle: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const hiddenCount = fields.filter((field) => hidden.has(field.key)).length;

  useEffect(() => {
    if (!open) return;
    function onDocPointerDown(event: PointerEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onDocPointerDown);
    return () => document.removeEventListener("pointerdown", onDocPointerDown);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <Button
        size="sm"
        variant="secondary"
        className="text-[11px]"
        onClick={() => setOpen((value) => !value)}
        title="选择明细表要显示的列"
      >
        <Columns3 size={14} />列{hiddenCount ? ` · ${hiddenCount}` : ""}
      </Button>
      {open ? (
        <div className="absolute right-0 z-30 mt-1 w-44 rounded-md border border-border bg-surface p-1 shadow-lg">
          {fields.map((field) => {
            const visible = !hidden.has(field.key);
            return (
              <button
                key={field.key}
                type="button"
                onClick={() => onToggle(field.key)}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-muted"
              >
                <span
                  className={cn(
                    "flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                    visible
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-surface",
                  )}
                >
                  {visible ? <Check size={11} /> : null}
                </span>
                <span className="truncate">{field.label}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
