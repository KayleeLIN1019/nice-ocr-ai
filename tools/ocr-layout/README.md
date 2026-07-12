# OCR 版面服务（行级原图定位）

本地 PaddleOCR 旁路服务：给审核台的「识别行 → 原图区域」提供**真实文字框坐标**，
替代多模态大模型自行估算的坐标（后者会脑补成等差网格、整体偏移，点哪行飘哪行）。

- Node 端通过 `OCR_LAYOUT_URL`（或设置页 `ocrLayoutUrl`）调用本服务。
- 服务只返回每条文字行的归一化包围盒 + 文本；行聚类与「按编码/名称匹配到识别行」在
  Node 侧 [src/lib/recognition/source-region-match.ts](../../src/lib/recognition/source-region-match.ts) 完成（纯函数、可单测、可换后端）。

## 安装（uv，Python 3.11）

```bash
cd tools/ocr-layout
uv venv --python 3.11 .venv
uv pip install --python .venv/Scripts/python.exe -r requirements.txt
# paddle 运行时依赖 pkg_resources，需 setuptools<81
uv pip install --python .venv/Scripts/python.exe "setuptools<81"
```

## 启动

```bash
OCR_LAYOUT_PORT=8077 .venv/Scripts/python.exe server.py
```

首次调用 `/layout` 会自动下载 PP-OCR 检测/识别模型（数十 MB，来自 paddle 模型服务器）。
默认已关闭文档方向/去扭曲/文字行方向三个可选子模型以减少下载；需要时设 `OCR_LAYOUT_ORIENT=1`。

## 接口

- `GET /health` → `{"status":"ok","lang":"ch"}`
- `POST /layout`，body 二选一：
  - `{"imagePath": "<本机绝对路径>"}`（与本服务同机时优先，零拷贝）
  - `{"imageBase64": "<...>"}`
  返回：`{"width":W,"height":H,"lines":[{"text","score","box":{x,y,w,h},"poly"}]}`，坐标归一化 0..1。

## 接入

1. 启动本服务。
2. 在 nice-ocr 的 `.env` 配 `OCR_LAYOUT_URL="http://127.0.0.1:8077"`（或设置页 `ocrLayoutUrl`）。
3. 设置 `sourceRegionMode=layout_ocr`（默认）。新识别的单据即用 OCR 真实坐标。
4. 历史单据可回填：`npm run db:backfill-source-region [documentId]`。
