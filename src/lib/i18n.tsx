"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";

export type Locale = "zh" | "en";
type LanguageContextValue = { locale: Locale; setLocale: (locale: Locale) => void; toggleLocale: () => void };
const LanguageContext = createContext<LanguageContextValue | null>(null);

// 仅翻译界面文案；商品名、文件名和识别结果等业务数据保持原样。
const translations: Record<string, string> = {
  工作区: "Workspace",
  数据: "Data",
  系统: "System",
  仪表盘: "Dashboard",
  批次管理: "Batches",
  全部结果: "All Results",
  审核工作台: "Review Center",
  产品库: "Product Library",
  冲突管理: "Conflicts",
  队列: "Queue",
  导入: "Import",
  规则字典: "Rules",
  设置: "Settings",
  智能单据识别: "Intelligent Document Recognition",
  队列空闲: "Queue is idle",
  队列处理中: "Processing queue",
  查看识别队列: "View recognition queue",
  展开侧边栏: "Expand sidebar",
  折叠侧边栏: "Collapse sidebar",
  面包屑: "Breadcrumb",
  "加载中...": "Loading...",
  "加载仪表盘...": "Loading dashboard...",
  "加载队列...": "Loading queue...",
  "加载结果...": "Loading results...",
  "加载审核台...": "Loading review workspace...",
  "加载设置中...": "Loading settings...",
  保存: "Save",
  "保存中...": "Saving...",
  保存设置: "Save settings",
  创建: "Create",
  取消: "Cancel",
  关闭: "Close",
  删除: "Delete",
  "删除中...": "Deleting...",
  确认删除: "Confirm delete",
  上传文件: "Upload files",
  "上传解析中...": "Uploading and parsing...",
  上传失败: "Upload failed",
  导出: "Export",
  "导出中…": "Exporting…",
  "追加中…": "Appending…",
  处理中: "Processing",
  成功: "Success",
  失败: "Failed",
  完成: "Completed",
  草稿: "Draft",
  排队: "Queued",
  排队中: "Queued",
  已取消: "Canceled",
  已完成: "Completed",
  "重试中...": "Retrying...",
  重新加入识别队列: "Requeue for recognition",
  全部: "All",
  全部状态: "All statuses",
  全部类型: "All types",
  全部批次: "All batches",
  清空: "Clear",
  操作: "Actions",
  状态: "Status",
  类型: "Type",
  名称: "Name",
  文件名: "File name",
  文档: "Document",
  文档数: "Documents",
  行数: "Rows",
  批次: "Batch",
  月份: "Month",
  备注: "Notes",
  来源: "Source",
  风险: "Risk",
  风险等级: "Risk level",
  风险详情: "Risk details",
  "风险原因：": "Risk reason:",
  原因: "Reason",
  严重度: "Severity",
  说明: "Description",
  处理建议: "Suggested action",
  识别: "Recognition",
  审核: "Review",
  结果: "Results",
  概览: "Overview",
  处理总数: "Total processed",
  文档总数: "Total documents",
  处理排队: "Queued",
  待审核行: "Rows to review",
  已确认行: "Confirmed rows",
  冲突数: "Conflicts",
  总处理时长: "Total processing time",
  单均处理时长: "Average processing time",
  明细行: "Detail rows",
  队列中: "In queue",
  可导出: "Ready to export",
  可重试: "Retry available",
  风险优先: "Risk first",
  查看原图: "View original",
  单据原图: "Original document",
  原图预览: "Original preview",
  没有符合条件的记录: "No matching records",
  暂无批次: "No batches",
  "暂无文档，请上传文件": "No documents. Upload files to get started.",
  暂无识别行: "No recognized rows",
  选择批次: "Select batch",
  新建批次: "New batch",
  删除批次: "Delete batch",
  删除月份批次: "Delete monthly batch",
  创建批次: "Create batch",
  批次名称: "Batch name",
  产品名: "Product name",
  产品名称: "Product name",
  产品编码: "Product code",
  编码: "Code",
  单位: "Unit",
  数量: "Quantity",
  单价: "Unit price",
  金额: "Amount",
  "搜索产品名/编码": "Search product name/code",
  搜索批次名称: "Search batch name",
  搜索文件名: "Search file name",
  导入结果: "Import results",
  导入批次: "Import batch",
  开始导入: "Start import",
  "导入中...": "Importing...",
  选择导出模板: "Select export template",
  选择本页全部行: "Select all rows on this page",
  待复审: "Needs review",
  已复审: "Reviewed",
  已确认: "Confirmed",
  审核通过: "Review approved",
  已排除: "Excluded",
  未审核: "Unreviewed",
  部分确认: "Partially confirmed",
  上一张: "Previous",
  下一张: "Next",
  上一页: "Previous page",
  下一页: "Next page",
  保存新行: "Save new row",
  删除此行: "Delete row",
  快速跳转文件: "Quick file jump",
  进入专注模式: "Enter focus mode",
  "退出专注模式（Esc）": "Exit focus mode (Esc)",
  清除: "Clear",
  "清除中...": "Clearing...",
  统一名称: "Unify name",
  统一编码: "Unify code",
  正常: "Normal",
  已解决: "Resolved",
  已忽略: "Ignored",
  未处理: "Unresolved",
  去修复: "Fix",
  启用中: "Enabled",
  已停用: "Disabled",
  标识码: "Rule code",
  中文名: "Chinese name",
  保存改动: "Save changes",
  识别策略: "Recognition strategy",
  AI自动通过: "AI auto-approved",
  人工确认: "Human confirmed",
  "自动（按优先级）": "Automatic (by priority)",
  手动: "Manual",
  测试模型连通性: "Test model connection",
  "测试中（发送 hi）...": "Testing (sending hi)...",
  重建产品库: "Rebuild product library",
  "上传已有 Excel": "Upload existing Excel",
  "上传已有 Excel，把当前范围的新数据追加进去":
    "Upload an existing Excel file and append new data from the current scope",
  切换导出模板: "Switch export template",
  "导出范围：当前筛选 / 批次": "Export scope: current filters / batch",
  "导出范围：全部结果": "Export scope: all results",
  "产品编码/名称": "Product code/name",
  到审核台查看原图并逐行复核: "Open the review workspace to inspect the original image row by row",
  "可缩放、拖拽核对原图": "Zoom and drag to compare with the original",
  排除行: "Exclude row",
  "请输入要统一替换成的产品编码。": "Enter the product code to replace it with.",
  中: "Medium",
  低: "Low",
  高: "High",
  冲突: "Conflict",
  冲突原因: "Conflict reason",
  同名多编码: "Same name, multiple codes",
  "审核：全部": "Review: all",
  待审核: "Pending review",
  "查看、筛选、编辑、确认所有识别明细行。": "View, filter, edit, and confirm all recognized detail rows.",
  标识类别: "Label type",
  行号: "Row number",
  "风险：全部": "Risk: all",
  "一键通过当前低风险单据（A）": "Approve the current low-risk document with one click (A)",
  "上一张（←）": "Previous (←)",
  "下一张（→）": "Next (→)",
  上次审核到的文档: "Last reviewed document",
  人工: "Manual",
  低风险抽检: "Low-risk spot check",
  全部队列: "All queue",
  可一键过: "One-click approval available",
  可过: "Can approve",
  在原图中定位此行: "Locate this row in the original",
  在审核它: "Review it",
  "在明细末尾新增一行（也可在某行右侧点「+」就近插入）":
    "Add a row at the end (or click + beside a row to insert nearby)",
  在此行下方插入新行: "Insert a new row below this row",
  审核到的行: "Reviewed rows",
  "对当前单据所属批次机器自动通过的行做二次复查（需 worker 运行）":
    "Recheck rows automatically approved in this document's batch (worker required)",
  "对机器自动通过的行做二次复查（需 worker 运行）": "Recheck automatically approved rows (worker required)",
  库: "Library",
  当前单据可一键通过: "This document can be approved with one click",
  "当前单据满足低风险条件时一键通过（A）": "Approve when this document meets low-risk conditions (A)",
  当前单据需要人工核对: "This document needs manual verification",
  "当前批次还没有文档，请先上传单据，或切换到「全部」查看其他批次。":
    "This batch has no documents. Upload documents first, or switch to All to view other batches.",
  "当前页没有少于 3 位的商品编码。": "There are no product codes shorter than 3 characters on this page.",
  待复核: "Needs review",
  必须人工: "Manual review required",
  抽检: "Spot check",
  "拖拽调整列宽，双击恢复自适应": "Drag to resize columns; double-click to restore auto-fit",
  "数据定位已关闭：点此开启，恢复点击行在原图定位":
    "Data location is off: click to enable row location on the original",
  "数据定位已开启：点击/悬停行可在原图定位高亮；点此关闭":
    "Data location is on: click or hover a row to highlight it on the original; click to turn off",
  "暂无待审文档。请先创建批次并上传单据。":
    "No documents await review. Create a batch and upload documents first.",
  "清除当前页已识别出的少于 3 位商品编码":
    "Clear product codes shorter than 3 characters recognized on this page",
  "确认删除（软删除，可在审计日志追溯）": "Confirm deletion (soft delete; traceable in the audit log)",
  "识别当前页少于 3 位的商品编码并高亮定位": "Find product codes shorter than 3 characters on this page",
  该文档暂无识别行: "This document has no recognized rows",
  请先填写商品名称: "Enter a product name first",
  "跳到下一个异常字段（E）": "Jump to the next invalid field (E)",
  选择明细表要显示的列: "Choose columns to display in the detail table",
  暂无识别尝试记录: "No recognition attempts",
  识别尝试: "Recognition attempts",
  识别明细: "Recognition details",
  待保存: "Unsaved",
  批量建议: "Batch suggestions",
  文件: "File",
  "删除此行？": "Delete this row?",
  "点击停用：停用后该原因在前端不再作为问题展示":
    "Click to disable: this reason will no longer appear as an issue",
  点击启用: "Click to enable",
  重置为代码默认释义: "Reset to the code default description",
  条: "items",
  "AI Provider / 模型": "AI Provider / Models",
  删除未保存模型: "Delete unsaved model",
  "主模型（pass1）": "Primary model (pass1)",
  "副模型（pass2）": "Secondary model (pass2)",
  "审核模型（第三次复核）": "Review model (third pass)",
  对单张图片的具体指令: "Specific instructions for one image",
  "干净行抽样率（0~1）": "Clean-row sample rate (0~1)",
  并发数: "Concurrency",
  "描述识别任务、输出约束等": "Describe the recognition task and output constraints",
  无文本回复: "No-text response",
  显示名: "Display name",
  显示名称: "Display name",
  "最大输出 Tokens": "Max output tokens",
  最大重试: "Max retries",
  没有启用模型: "No enabled models",
  用户提示词覆盖: "User prompt override",
  "用户提示词（User）": "User prompt (User)",
  留空则使用全局默认用户提示词: "Leave blank to use the global default user prompt",
  留空则使用全局默认系统提示词: "Leave blank to use the global default system prompt",
  留空则保留当前密钥: "Leave blank to keep the current key",
  系统提示词覆盖: "System prompt override",
  "系统提示词（System）": "System prompt (System)",
  "自定义 Provider": "Custom Provider",
  "请先保存 provider 并填写模型": "Save the provider and enter a model first",
  请先保存后导入: "Save first, then import",
  "输入 API Key": "Enter API Key",
  退避秒数: "Backoff seconds",
  "配置协议、密钥、模型选项与提示词覆盖；改动需点右上角「保存设置」后生效。":
    "Configure protocols, keys, models, and prompt overrides; changes take effect after clicking Save settings.",
  金额容差: "Amount tolerance",
  "（未启用）": "(disabled)",
  "全人工：所有行人工确认": "Manual: confirm every row",
  "双模型交叉验证（新建批次继承）": "Two-model cross-validation (inherited by new batches)",
  "审核（确认后二次复查）": "Review (second pass after confirmation)",
  "默认审批模式（新建批次继承）": "Default approval mode (inherited by new batches)",
  默认模式: "Default mode",
  协议: "Protocol",
  模型选项: "Model options",
  全局识别提示词: "Global recognition prompts",
  已保存: "Saved",
  无密钥: "No key",
  已配密钥: "Key configured",
  "AI自动：双次一致即自动通过，高风险转人工":
    "AI auto: approve on two matching passes; send high risk to manual review",
  "balanced：有自动通过候选时二次识别": "balanced: run a second pass when an auto-approval candidate exists",
  "consensus：全量多次识别": "consensus: recognize everything multiple times",
  "fast：单次识别": "fast: single pass",
  "manual：人工导入/录入": "manual: manual import/entry",
  放大: "Zoom in",
  缩小: "Zoom out",
  适应窗口: "Fit to window",
  "Ctrl+滚轮缩放 · 放大后可拖拽": "Ctrl + mouse wheel to zoom · drag after zooming",
  "原图不可用（未上传或文件缺失）": "Original unavailable (not uploaded or file missing)",
  定位到识别行: "Locate recognized row",
  图片: "Image",
  直接上传的图片: "Directly uploaded image",
  "前缀标识 + 看具体来源": "Prefix label + see the specific source",
  原始错误: "Original error",
  识别失败: "Recognition failed",
  待人工复核: "Awaiting manual review",
  待核查: "Awaiting verification",
  识别中: "Recognizing",
  需复核: "Needs review",
  "混合(AI+人工)": "Hybrid (AI + manual)",
  已上传: "Uploaded",
  已暂停: "Paused",
  已识别: "Recognized",
  已审核: "Reviewed",
  月份批次: "Monthly batch",
  刷新状态: "Refresh status",
  处理情况: "Processing overview",
  自动通过率: "Auto-approval rate",
  前往复审: "Open review",
  "包含批次：": "Included batches:",
  待处理风险: "Risks to review",
  进入审核: "Open review",
  "最近失败 / 高风险": "Recent failures / high risk",
  更新时间: "Updated",
  重试: "Retry",
  需要人工复核: "Manual review required",
  暂无未处理风险: "No unresolved risks",
  暂无失败或高风险文档: "No failed or high-risk documents",
  "暂无批次，请先在批次管理中创建并上传单据。": "No batches yet. Create a batch and upload documents first.",
  每单据平均: "Average per document",
  自动通过候选: "Auto-approval candidate",
  "已确认 /": "Confirmed /",
  等: "and",
  月批次: "Monthly batch",
  "按批次维护上传、识别、审核、导出进度。": "Manage uploads, recognition, review, and exports by batch.",
  新建月份批次: "New monthly batch",
  编辑月份批次: "Edit monthly batch",
  调整月份批次信息和包含批次: "Update monthly batch details and included batches",
  将多个普通批次打包到同一个月份: "Group multiple batches under one month",
  "支持 图片 / PDF / ZIP 压缩包": "Images, PDFs, and ZIP archives supported",
  上传: "Upload",
  审核进度: "Review progress",
  审批模式: "Approval mode",
  创建时间: "Created",
  清除月份筛选: "Clear month filter",
  "暂无月份批次，可将多个普通批次打包到一个月份。":
    "No monthly batches yet. Group regular batches under a month.",
  此操作不可撤销: "This action cannot be undone",
  留空则按月份命名: "Leave blank to use the month as the name",
  普通批次不会被删除: "Regular batches will not be deleted",
  contains批次: "Batches",
  共: "Total",
  "请选择或输入要统一成的值。": "Select or enter the value to use.",
  仅看冲突: "Conflicts only",
  "共 1794 个产品": "1,794 products",
  导入历史: "Import history",
  "正在导入历史记录，请稍候（大文件可能需要数十秒）…":
    "Importing history. Please wait; large files may take a few seconds…",
  别名: "Aliases",
  出现次数: "Occurrences",
  来源文档: "Source documents",
  最近出现: "Last seen",
  模糊搜索: "Fuzzy search",
  精确搜索: "Exact search",
  尝试: "Attempts",
  最近错误: "Last error",
  入队时间: "Queued at",
  识别队列: "Recognition queue",
  "查看并维护所有识别 / 审核作业的处理进度。": "Monitor and manage all recognition and review jobs.",
  刷新: "Refresh",
  重试全部失败: "Retry all failed",
  "导入 v5 数据": "Import v5 data",
  "导入历史 recognition-results.json，自动归一化为批次、文档与识别明细行。":
    "Import recognition-results.json and normalize it into batches, documents, and recognized rows.",
  "点击选择 recognition-results.json": "Click to choose recognition-results.json",
  "JSON 数组格式": "JSON array format",
  识别行: "Recognized rows",
  批次工作区: "Batch workspace",
  专注: "Focus",
  复审: "Recheck",
  一键通过: "Approve all",
  短码: "Short codes",
  定位: "Locate",
  列: "Columns",
  新增: "Add row",
  下个异常: "Next issue",
  审计日志: "Audit log",
  解决: "Resolve",
  忽略: "Ignore",
  来源行: "Source row",
  产品库冲突: "Product library conflicts",
  "维护识别校验、产品库冲突、二次审核与模型异常的中文释义、严重度与处理建议。改动即时生效于审核台、冲突管理与仪表盘。":
    "Maintain recognition checks, product conflicts, second-pass review, and model issue definitions, severity levels, and recommended actions. Changes take effect immediately across Review Center, Conflicts, and Dashboard.",
  二次审核: "Second-pass review",
  重置: "Reset",
  "混合：双次一致+低风险自动通过，其余转人工":
    "Hybrid: auto-approve low-risk matches; route everything else to review",
  继承全局默认: "Use global default",
  "两次识别分别用主、副模型，两次一致才允许 AI 自动通过。副模型留空则自动选另一个启用模型，无其他可用时退化为主模型双跑。":
    "Run the primary and secondary models independently; auto-approve only when both agree. If no secondary model is selected, the next enabled model is used, falling back to a second pass with the primary model when necessary.",
  "配置识别策略、AI provider、队列重试和校验规则。":
    "Configure recognition strategy, AI providers, queue retries, and validation rules.",
  PDF渲染倍率: "PDF render scale",
  "新增 Provider": "Add provider",
  配置: "Configure",
  启用: "Enabled",
  "对“机器自动通过”的行做规则/统计预筛 + 第三次独立 AI 交叉验证，存疑行进复审队列交给人工。手动在批次/审核台点「运行复核」触发。":
    "Run rule and statistical checks plus a third independent AI pass on machine-approved rows. Send uncertain rows to the review queue. Start it from a batch or the Review Center.",
  运行复核: "Run recheck",
  点击停用: "Click to disable",
  MediumRisk: "Medium risk",
  LowRisk: "Low risk",
  HighRisk: "High risk",
  同编码多名称: "Same code, multiple names",
  同名称多单位: "Same name, multiple units",
  同一商品名对应多个编码: "One product name maps to multiple codes",
  同一编码对应多个商品: "One code maps to multiple products",
  个产品: "products",
  个批次: "batches",
  个项目: "items",
  "上传已有 Excel 追加": "Append an existing Excel file",
  优先级: "Priority",
  AI自动: "AI automatic",
  全人工: "Manual review",
  商品名: "Product name",
  删除失败: "Delete failed",
  "删除批次（含文档与识别结果）": "Delete batch (including documents and recognition results)",
  "删除月份批次（不删除普通批次）": "Delete monthly batch (regular batches are kept)",
  到审核台查看原图并复核: "Open Review Center to verify the original image",
  "加载中…": "Loading…",
  单据: "Document",
  "暂无批次，点击右上角新建批次": "No batches yet. Click New batch to get started.",
  未登记: "Not registered",
  查看风险详情: "View risk details",
  点击查看批次详情与预览: "Open batch details and preview",
  点击编辑: "Click to edit",
  筛选月份批次: "Filter monthly batches",
  编辑识别行: "Edit recognized row",
  重试中: "Retrying",
  商品编码: "Product code",
  商品名称: "Product name",
  商品: "Product",
  月: "Month",
  "按严重度处理产品库和识别明细中的数据质量问题。":
    "Review data-quality issues in the product library and recognition results by severity.",
  仅看未处理: "Unresolved only",
  冲突类型: "Conflict type",
  "导入采购统计表（.xlsx）：写入产品库并作为单位历史校验基线":
    "Import a purchasing report (.xlsx) to update the product library and establish unit-history checks",
  "从识别明细沉淀产品资料，并维护编码、名称、单位冲突。":
    "Build product records from recognition results and manage code, name, and unit conflicts.",
  "暂无产品，请先重建产品库": "No products yet. Rebuild the product library first.",
  暂无冲突: "No conflicts",
  空编码: "Blank code",
  统一后的商品名: "Unified product name",
  统一后的编码: "Unified product code",
  在全部结果中精确搜索该商品: "Find this product in All Results",
  "仅隐藏该冲突记录，不修改识别明细": "Hide this conflict only; recognition results will not be changed",
  一致性校验: "Consistency check",
  二次识别: "Second pass",
  审核复查: "Review recheck",
  暂无失败作业: "No failed jobs",
  队列为空: "Queue is empty",
  "导入成功，可前往全部结果或仪表盘查看。": "Import complete. View the results in All Results or Dashboard.",
  单据预览: "Document preview",
  原始文件: "Original file",
  文件列表: "File list",
  查看原图并审核修改识别明细: "View the original image and edit recognition results",
  "标记本批次审核完成（收口）": "Mark this batch as reviewed",
  文档已在队列中或正在处理: "This document is already queued or being processed",
  在右侧预览此文件: "Preview this file on the right",
  原图不可用: "Original unavailable",
  行校验: "Row validation",
  "模型/接口异常": "Model / API issues",
  疑似非商品名: "Possible non-product name",
  金额不平: "Amount mismatch",
  规则校验未通过: "Rule check failed",
  单价离群: "Price outlier",
  单位与历史不符: "Unit differs from history",
  疑似重复行: "Possible duplicate row",
  模型响应超时: "Model timed out",
  触发限流: "Rate limit reached",
  鉴权失败: "Authentication failed",
  额度不足: "Quota exhausted",
  模型解析失败: "Model response could not be parsed",
  网络错误: "Network error",
  未知模型错误: "Unknown model error",
  "该名称命中非商品名词库（如合计/备注/单位/数量），或为纯数字/符号，可能是表头或汇总行被误识别成了商品。":
    "This name matches a non-product term such as total, notes, unit, or quantity, or contains only numbers and symbols. It may be a misread header or summary row.",
  "核对原图：若不是真实商品请删除该行；若是商品则修正名称后再确认。":
    "Check the original image. Delete the row if it is not a real product; otherwise correct the name and confirm it.",
  "数量 × 单价 与 识别金额 不一致（超过容差 0.01），三者中至少有一个识别有误。":
    "Quantity × unit price does not match the recognized amount beyond the 0.01 tolerance. At least one value may be wrong.",
  "对照原图核对数量、单价、金额，修正识别错误的一项。":
    "Compare quantity, unit price, and amount with the original image, then correct the incorrect value.",
  "二次审核重跑行校验时仍存在未通过项（如非商品名 / 金额不平）。":
    "A second-pass check still found validation issues, such as a non-product name or an amount mismatch.",
  "回到该行按提示修正后重新确认。": "Return to the row, follow the guidance, and confirm it again.",
  "该单价显著偏离同一商品的历史中位数（默认高于 3 倍或低于 1/3）。":
    "This unit price is far from the product's historical median, typically above 3× or below ⅓ of it.",
  "核对单价是否识别错位（小数点/千分位），或确属促销/批发价。":
    "Check the decimal point and thousands separator, or confirm that this is a promotional or wholesale price.",
  "该单位与同一商品历史主导单位不一致。": "This unit differs from the product's historical primary unit.",
  "确认本次单位是否识别有误，或确属不同规格。":
    "Check whether the unit was misread or the product is a different specification.",
  "文档内存在「编码/名称 + 数量 + 单价 + 金额」完全一致的重复行。":
    "The document contains duplicate rows with identical code/name, quantity, unit price, and amount.",
  "核对是否重复录入，确认后删除多余行。":
    "Check whether the row was entered twice, then delete the extra row if confirmed.",
  "调用识别模型超过等待时间仍未返回结果。":
    "The recognition model did not respond within the timeout period.",
  "稍后重试；多次超时可在设置中改用更快的模型或缩小图片尺寸。":
    "Try again later. If timeouts continue, choose a faster model or reduce the image size in Settings.",
  "模型服务商返回限流（429 / Too Many Requests）。":
    "The model provider returned a rate-limit response (429 / Too Many Requests).",
  "降低队列并发或稍后重试；必要时提升服务商配额。":
    "Reduce queue concurrency or try again later. Increase the provider quota if needed.",
  "API Key 无效或权限不足（401 / 403）。": "The API key is invalid or does not have permission (401 / 403).",
  "到设置页检查该服务商的 API Key 与访问权限。":
    "Check the provider API key and access permissions in Settings.",
  "服务商返回额度耗尽 / 欠费相关错误。": "The provider reported an exhausted quota or billing issue.",
  "检查账户余额或配额后重试。": "Check the account balance or quota, then try again.",
};

function translateText(value: string, locale: Locale) {
  if (locale === "zh") return value;
  const exact = translations[value.trim()];
  if (exact) return value.startsWith(" ") ? ` ${exact}` : exact;
  const dynamic = value
    .replace(/^共 (\d+) 条，第 (\d+) \/ (\d+) 页$/, "Total $1 items, page $2 / $3")
    .replace(/^共 (\d+) 个$/, "Total $1 items")
    .replace(/^共 (\d+) 个产品$/, "$1 products")
    .replace(/^(\d+) 个产品$/, "$1 products")
    .replace(/^(\d+) 个$/, "$1 items")
    .replace(/^(\d+) 次$/, "$1 attempts")
    .replace(/^(\d+) 行$/, "$1 rows")
    .replace(/^(\d+) 行未审 · 第 (\d+) 行$/, "$1 pending rows · row $2")
    .replace(/^另有 (\d+) 张单据未完成$/, "$1 more documents unfinished")
    .replace(/^有未确认行，进入审核台查看$/, "Unconfirmed rows remain. Open Review Center.")
    .replace(/^第 (\d+)\/(\d+) 页$/, "Page $1/$2")
    .replace(/^第 (\d+) \/ (\d+) 页$/, "Page $1 / $2")
    .replace(/^可过 (\d+) · 抽检 (\d+)$/, "$1 approvable · $2 spot checks")
    .replace(/^同名多码 (\d+)$/, "Same name, multiple codes: $1")
    .replace(/^列 · (\d+)$/, "Columns · $1")
    .replace(/^已确认(\d+\/\d+) 行 · (\d+)\/(\d+)$/, "Confirmed $1 rows · $2/$3")
    .replace(/^(\d+) 行空编码$/, "$1 rows with blank codes")
    .replace(/^待审 (\d+)$/, "$1 pending review")
    .replace(/^当前 (\d+) 个$/, "$1 selected")
    .replace(/^确认率 (\d+)%$/, "Confirmation rate $1%")
    .replace(/^重试全部失败(\d+)?$/, "Retry all failed$1")
    .replace(/^已封批 (.+) · 点击撤销$/, "Batch closed $1 · click to undo")
    .replace(/^打开 (.+)，定位到第 (\d+) 行$/, "Open $1 and locate row $2")
    .replace(/^第 (\d+) 行 (.+)$/, "Row $1 $2")
    .replace(
      /^当前批次：(.+)，系统以风险优先处理待审核数据。$/,
      "Current batch: $1. The system prioritizes high-risk rows for review.",
    )
    .replace(/^当前月份批次：(.+)，包含 (\d+) 个批次。$/, "Current monthly batch: $1, containing $2 batches.")
    .replace(
      /^已将「(.+)」统一为编码 (.+)，更新 (\d+) \/ (\d+) 行。$/,
      'Unified "$1" to code $2; updated $3 / $4 rows.',
    )
    .replace(/^设为目标编码 (.+)$/, "Set as target code $1")
    .replace(/^设为统一目标：(.+)$/, "Set as unified target: $1")
    .replace(/^产品库建议单位：(.+)$/, "Product library suggested unit: $1")
    .replace(/^产品库高置信候选：(.+)$/, "High-confidence product library candidate: $1")
    .replace(/^产品库\/历史建议编码：(.+)$/, "Product library / historical suggested code: $1")
    .replace(/^同一商品名对应多个编码：(.+)$/, "One product name maps to multiple codes: $1")
    .replace(/^同一编码对应多个商品：(.+)$/, "One code maps to multiple products: $1")
    .replace(
      /^原因码（(.+)）尚未在规则字典登记。$/,
      "Reason code ($1) is not registered in the rule dictionary.",
    )
    .replace(/队列处理中/g, "Processing queue")
    .replace(/确认率/g, "Confirmation rate")
    .replace(/当前月份批次/g, "Current monthly batch")
    .replace(/当前批次/g, "Current batch")
    .replace(/包含批次/g, "Batches")
    .replace(/包含/g, "contains")
    .replace(/个批次/g, " batches")
    .replace(/个文档/g, " documents")
    .replace(/单已计时/g, " documents timed");
  return dynamic;
}

const originalText = new WeakMap<Text, { original: string; translated: string }>();
const originalAttributes = new WeakMap<Element, Map<string, { original: string; translated: string }>>();
const originalFormValues = new WeakMap<
  HTMLInputElement | HTMLTextAreaElement,
  { original: string; translated: string }
>();

function translateDom(root: Element, locale: Locale) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    const parent = node.parentElement;
    if (
      !parent ||
      parent.closest("[data-i18n-ignore]") ||
      ["SCRIPT", "STYLE", "TEXTAREA", "INPUT"].includes(parent.tagName)
    )
      continue;
    const current = node.nodeValue ?? "";
    const entry = originalText.get(node);
    if (!entry) originalText.set(node, { original: current, translated: current });
    else if (current !== entry.translated) entry.original = current;
    const original = originalText.get(node)!;
    let next = translateText(original.original, locale);
    if (locale === "en" && ["个", "条", "行"].includes(original.original.trim())) {
      const previous = node.previousSibling?.nodeValue?.trim() ?? "";
      if (/^\d/.test(previous) || previous === "共" || previous === "Total") {
        const unit = original.original.trim() === "行" ? "rows" : "items";
        next = original.original.startsWith(" ") ? ` ${unit}` : unit;
      }
    }
    original.translated = next;
    if (next !== node.nodeValue) node.nodeValue = next;
  }
  root.querySelectorAll?.("[title], [aria-label], [placeholder]").forEach((element) => {
    if (element.closest("[data-i18n-ignore]")) return;
    for (const attribute of ["title", "aria-label", "placeholder"]) {
      const value = element.getAttribute(attribute);
      if (!value) continue;
      const originals =
        originalAttributes.get(element) ?? new Map<string, { original: string; translated: string }>();
      const entry = originals.get(attribute);
      if (!entry) originals.set(attribute, { original: value, translated: value });
      else if (value !== entry.translated) entry.original = value;
      originalAttributes.set(element, originals);
      const next = translateText(originals.get(attribute)!.original, locale);
      originals.get(attribute)!.translated = next;
      if (value !== next) element.setAttribute(attribute, next);
    }
  });
  root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea").forEach((element) => {
    if (!element.closest("[data-i18n-system]")) return;
    const current = element.value;
    const entry = originalFormValues.get(element);
    if (!entry) originalFormValues.set(element, { original: current, translated: current });
    else if (current !== entry.translated) entry.original = current;
    const original = originalFormValues.get(element)!;
    const next = translateText(original.original, locale);
    original.translated = next;
    if (current !== next) element.value = next;
  });
}

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  // The public interview demo opens in English; the language toggle still keeps the Chinese UI available.
  const [locale, setLocaleState] = useState<Locale>("en");
  useEffect(() => {
    const stored = window.localStorage.getItem("nice-ocr-locale");
    if (stored === "en" || stored === "zh") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate the persisted language preference after SSR
      setLocaleState(stored);
    }
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale === "en" ? "en" : "zh-CN";
    document.documentElement.dataset.locale = locale;
    translateDom(document.body, locale);
    const observer = new MutationObserver(() => translateDom(document.body, locale));
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["title", "aria-label", "placeholder"],
    });
    return () => observer.disconnect();
  }, [locale]);
  const value = useMemo<LanguageContextValue>(
    () => ({
      locale,
      setLocale: (next) => {
        setLocaleState(next);
        window.localStorage.setItem("nice-ocr-locale", next);
      },
      toggleLocale: () => {
        const next = locale === "zh" ? "en" : "zh";
        setLocaleState(next);
        window.localStorage.setItem("nice-ocr-locale", next);
      },
    }),
    [locale],
  );
  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  const value = useContext(LanguageContext);
  if (!value) throw new Error("useLanguage must be used inside LanguageProvider");
  return value;
}
