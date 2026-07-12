# nice-ocr

> 公开演示版：使用脱敏样例数据，用于展示单据识别、审核分流、产品冲突管理和结果导出工作流。线上环境不包含真实业务数据或 API 密钥。

本地优先的智能单据 OCR 工作台，用于把副食品销售单、采购单、表格图片等原始资料转成可审核、可追溯、可导出的结构化数据。

它不是一个简单的“图片转文字”工具，而是一条完整的业务流水线：

```text
上传图片 / PDF / ZIP
  -> AI 视觉模型识别明细
  -> 双模型交叉校验 + 规则风控
  -> 人工审核、编辑、确认
  -> 二次复审与冲突处理
  -> Excel 导出 / 产品库沉淀
```

## 亮点

- **本地优先**：SQLite + 本地文件存储，数据、图片、识别结果和审计记录都沉淀在本机。
- **批次化处理**：按批次上传、识别、审核、封批，适合日常连续处理大量单据。
- **AI Provider 可配置**：支持 OpenAI Responses API 与 Anthropic Messages API，Provider、模型、密钥、提示词都在后台维护。
- **多模型校验**：主识别、副识别、审核模型可以独立选择，用一致性和规则降低错漏风险。
- **人工审核友好**：原图缩放拖拽、行级编辑、风险提示、确认、软删除、新增行、批次上下文导航一体化。
- **来源可追溯**：PDF 页码、ZIP 条目、原文件名、识别尝试、字段变更审计都保留下来。
- **导出灵活**：支持识别结果、产品库、批次范围、筛选范围、行级多选、模板化 Excel 和追加/合并导出。
- **可维护产品库**：从识别行沉淀产品观察，发现编码、名称、单位等冲突并辅助维护。

## 业务模块

| 模块 | 作用 |
| --- | --- |
| 仪表盘 | 汇总待处理任务、队列状态、审核进度，并支持直达审核 |
| 批次 | 新建批次、上传文件、查看批次文件、审核进度和封批状态 |
| 队列 | 查看识别任务，支持重试、取消和批量维护失败任务 |
| 审核台 | 对照原图编辑识别行，确认、复审、新增、删除和处理风险 |
| 结果 | 查询、筛选、内联编辑、批量选择并导出识别结果 |
| 产品库 | 维护产品主数据、别名、单位和备注 |
| 冲突 | 处理同码异名、名称异常、规则命中等可追溯冲突 |
| 规则字典 | 管理风险原因、异常分类和前端展示文案 |
| 设置 | 维护 AI Provider、模型目录、识别策略、审核配置 |
| v5 导入 | 导入历史 JSON / 图片数据，平滑迁移旧系统资料 |

## 技术栈

| 层级 | 技术 |
| --- | --- |
| 前端 | Next.js 16 App Router, React 19, TypeScript, Tailwind CSS 4, lucide-react |
| 数据获取 | TanStack Query, TanStack Table |
| 后端 | Next.js API Routes, Zod 请求校验, 统一错误处理 |
| 数据库 | SQLite, Prisma 7, better-sqlite3 driver adapter |
| 队列 | 数据库任务队列, 独立 worker, 乐观锁领取任务, 有界并发 |
| AI | openai SDK, Anthropic SDK, Provider 抽象, 模型目录配置 |
| 文件 | 本地 storage, 图片/PDF/ZIP ingest, PDF 逐页展开 |
| 导出 | ExcelJS, 流式 xlsx 导出, 模板渲染 |
| 质量 | ESLint, TypeScript typecheck, Node test runner, GitHub Actions |

## 快速开始

环境要求：

- Node.js >= 22
- pnpm
- Windows / macOS / Linux 均可；当前开发环境为 Windows + WSL

```bash
cd nice-ocr
pnpm install
cp .env.example .env
pnpm db:generate
pnpm db:push
pnpm db:seed
pnpm dev
```

打开 `http://localhost:3000`。

如果只启动 Web 服务，上传后的文件会入队，但不会真正识别。真实 AI 识别需要另开终端启动 worker：

```bash
cd nice-ocr
pnpm worker
```

## 本机启动脚本

仓库根目录提供了两个启动脚本，会检查依赖、准备 `.env`、安装 Node 依赖、同步 Prisma，启动前清理旧的 Web/OCR/worker 进程，并分别启动 Web 与 worker。`tools/ocr-layout` 的 PaddleOCR 版面服务会在检测到 Python 3.10-3.12 时自动创建虚拟环境并启动；没有 Python 时会跳过，worker 会回退到模型坐标。

Windows PowerShell：

```powershell
.\start-windows.ps1
```

macOS：

```bash
./start-mac.command
```

依赖检查范围：

- 必需：Node.js >= 22、pnpm（缺失时脚本会尝试用 Corepack 启用）。
- 自动准备：`nice-ocr/.env`、`pnpm install`、`pnpm db:generate`、`pnpm db:push`。
- 可选 OCR：Python 3.10-3.12、`tools/ocr-layout/requirements.txt` 内的 PaddleOCR/FastAPI/Uvicorn/Pillow。

脚本不会自动执行 `pnpm db:seed`，避免覆盖本地业务数据。需要跳过耗时步骤时：

```powershell
.\start-windows.ps1 -SkipInstall -SkipOcr
```

```bash
./start-mac.command --skip-install --skip-ocr
```

## Docker 部署

`nice-ocr/Dockerfile` 会把 Web、worker、OCR layout 三个服务打包进同一个镜像，容器入口脚本会先同步 SQLite schema，然后启动三个进程。SQLite 数据库和本地文件存储挂载到 `/data`。

```bash
cd nice-ocr
docker compose up --build
```

打开 `http://localhost:3000`。

`docker-compose.yml` 默认使用 `linux/amd64`，主要是为了让 PaddlePaddle/PaddleOCR 在 Windows 和 Apple Silicon macOS 上也走更稳定的镜像架构。

常用环境变量：

- `DATABASE_URL`：默认 `file:/data/nice-ocr.db`。
- `STORAGE_DIR`：默认 `/data/storage`。
- `PROVIDER_KEY_ENCRYPTION_KEY`：保存 Provider API Key 前建议设置，生成方式：`openssl rand -base64 32`。
- `ENABLE_OCR_LAYOUT`：默认 `1`，设为 `0` 可不启动 PaddleOCR layout 服务。
- `OCR_LAYOUT_URL`：默认 `http://127.0.0.1:8077`，worker 在同容器内调用本地 OCR layout 服务。

如果只想构建镜像：

```bash
cd nice-ocr
docker build -t nice-ocr:local .
```

首次使用前进入 `/settings` 配置 AI Provider。Provider 的 Base URL、API Key、协议、启用状态、模型目录和提示词都存入数据库，不依赖 `.env`。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | 启动 Next 开发服务器 |
| `pnpm worker` | 启动识别 worker |
| `pnpm build` | 生产构建 |
| `pnpm start` | 启动生产服务 |
| `pnpm lint` | ESLint 检查 |
| `pnpm typecheck` | TypeScript 类型检查 |
| `pnpm test` | 使用隔离测试库运行测试 |
| `pnpm db:generate` | 生成 Prisma Client |
| `pnpm db:push` | 同步 schema 到 SQLite |
| `pnpm db:seed` | 写入演示数据 |
| `pnpm db:encrypt-secrets` | 加密历史明文 Provider 密钥 |

修改 `prisma/schema.prisma` 后，需要重新执行：

```bash
pnpm db:generate
pnpm db:push
```

## 典型工作流

1. 在 `/batches` 新建批次，选择识别策略和导出模板。
2. 上传图片、PDF 或 ZIP。PDF 会按页拆成文档，ZIP 会保留包内条目路径。
3. 启动 `pnpm worker`，等待队列识别完成。
4. 进入 `/review`，对照原图修正识别行并确认。
5. 对自动通过的行运行二次审核，处理待复审建议。
6. 在 `/products` 或 `/conflicts` 维护产品库和冲突。
7. 在 `/results` 按批次、筛选条件或选中行导出 Excel。
8. 批次审核完毕后封批，形成稳定交付结果。

## 架构

```text
Browser
  |
  | Next.js pages / API routes
  v
Next.js App
  |
  | Prisma
  v
SQLite database
  |
  | file paths
  v
storage/

Worker process
  |
  | claim jobs from database queue
  v
AI providers
```

核心设计原则：

- 数据库只保存结构化数据和文件路径，图片、缩略图、原始响应、导出文件放在 `storage/`。
- 队列由数据库驱动，worker 通过乐观锁原子领取任务，避免重复消费。
- 表结构不依赖级联删除，业务删除、审计和状态流转由代码显式控制。
- 字段 schema 是识别、审核、表格和导出的单一事实源，降低前后端字段漂移。
- API 写操作使用 Zod 校验、事务和审计 diff，避免静默失败和无痕覆盖。

## 数据模型

| 实体 | 说明 |
| --- | --- |
| `Batch` | 一次业务处理批次，包含策略、模板、封批状态 |
| `Document` | 单张图片或 PDF 页，记录来源、状态、风险和文件路径 |
| `RecognitionJob` | 后台识别/审核任务，支持重试、锁定和失败原因 |
| `ExtractionAttempt` | 一次 Provider/模型识别尝试，保留原始输出、耗时和成本信息 |
| `RecognitionRow` | 标准化识别明细行，是审核、导出和产品观察的核心数据 |
| `ProductObservation` | 从识别行沉淀出的产品事实 |
| `Product` | 用户维护的产品主数据 |
| `ProductConflict` | 产品编码、名称、单位等冲突记录 |
| `AuditLog` | 用户编辑、确认、删除、审核等行为的审计日志 |
| `AiProviderConfig` | AI Provider 配置、协议、密钥、提示词 |
| `AiProviderModel` | Provider 下可选模型目录 |
| `RuleCatalog` | 风险规则和异常分类字典 |
| `ExportRecord` | 导出记录和文件路径 |

## 目录结构

```text
nice-ocr/
├─ src/app/                 # 页面与 API routes
├─ src/components/          # 业务页面组件和基础 UI
│  ├─ batches/
│  ├─ dashboard/
│  ├─ queue/
│  ├─ results/
│  ├─ review/
│  ├─ rules/
│  └─ settings/
├─ src/lib/
│  ├─ api/                  # API client 与路径
│  ├─ crypto/               # Provider 密钥加密
│  ├─ db/                   # Prisma client
│  ├─ fields/               # 字段 schema 单一事实源
│  ├─ files/                # 上传、存储、PDF/ZIP ingest
│  ├─ products/             # 产品冲突逻辑
│  ├─ queue/                # 数据库队列
│  ├─ recognition/          # Provider、模型、提示词、审核
│  ├─ rules/                # 规则字典
│  ├─ validation/           # 行级校验
│  └─ workflows/            # 批次、行、导入、导出等业务流程
├─ prisma/
│  ├─ schema.prisma
│  └─ seed.ts
├─ scripts/
│  ├─ worker.ts
│  ├─ test.ts
│  └─ encrypt-secrets.ts
└─ storage/                 # 本地运行生成，通常不提交
```

## 页面路由

| 路由 | 页面 |
| --- | --- |
| `/` | 仪表盘 |
| `/batches` | 批次列表 |
| `/batches/[id]` | 批次详情和文件预览 |
| `/queue` | 识别队列 |
| `/review` | 审核工作台 |
| `/results` | 识别结果 |
| `/products` | 产品库 |
| `/conflicts` | 冲突处理 |
| `/rules` | 规则字典 |
| `/settings` | AI 和系统设置 |
| `/import` | v5 历史数据导入 |

## API 概览

主要 API 位于 `src/app/api`：

- `batches/*`：批次创建、详情、上传、审核记录
- `documents/*`：文档列表、图片读取、重试、审计
- `queue/*`：队列查询、取消、重试、批量重试
- `rows/*`：识别行新增、编辑、删除、批量确认
- `products/*`：产品库维护和重建
- `conflicts/*`：冲突查询与处理
- `exports/*`：识别结果、产品库和模板导出
- `settings/*`：Provider、模型和策略设置
- `rules/*`：规则字典维护
- `import/v5`：历史数据导入
- `health`：健康检查

## 测试与质量

```bash
pnpm lint
pnpm typecheck
pnpm test
```

测试使用独立的 `test.db`，不会污染开发库。当前覆盖重点包括识别工作流、行编辑、导出范围、导出模板、规则校验、Provider 解析和产品冲突逻辑。

## 开发时间线

| 日期 | 事件 |
| --- | --- |
| 2026-06-16 | 初始化项目，重建 Next + SQLite + worker 的 OCR 工作流基础 |
| 2026-06-17 | 接通真实 API、AI Provider、双模型校验、审核台、分页、v5 导入和审核模块 |
| 2026-06-18 | 引入字段 schema、图片/PDF/ZIP 上传、识别行新增删除、审计和相关测试 |
| 2026-06-19 | 完成多模型 Provider、安全加密、限流、队列、流式上传/导出、CI、规则字典、导出模板和场景驱动抽取 |
| 2026-06-21 | 完成批次工作区导航、审核进度、封批、批次范围审核、原图查看器拖拽和审核入口优化 |

## 迁移说明

旧版 `docs/v5_new_3 2` 以 JSON 和本地图片为主。新系统通过 `/import` 支持导入：

- `recognition-results.json`
- `image-library.json`
- `product-library.json`
- 可选图片目录

导入后会创建迁移批次，尽量保留历史识别行、图片来源、产品信息和审计线索。

## 环境变量

`.env` 只保存基础运行配置：

| 变量 | 说明 |
| --- | --- |
| `DATABASE_URL` | SQLite 数据库地址，默认可使用 `file:./dev.db` |

AI Provider 的密钥不放在 `.env` 中，而是在 `/settings` 维护并写入数据库。已有明文密钥可用 `pnpm db:encrypt-secrets` 迁移为 AES-256-GCM 加密格式。

## 状态

项目处于活跃开发阶段，数据库表结构可以随业务最佳实践继续调整。当前优先级是让单据识别、审核、冲突处理和导出这条主业务链路稳定、可追溯、可维护。
