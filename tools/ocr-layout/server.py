"""本地 PaddleOCR 版面服务（行级原图定位用）。

设计要点：
- 常驻进程，启动时加载一次 PaddleOCR 模型；Node 端 worker 通过 HTTP 调用，避免每张图冷启动。
- 只做「检测 + 识别」并返回每条文字行的归一化包围盒 + 文本 + 置信度；
  行聚类、与识别结果的匹配放在 Node 端纯函数里做（可单测、可换后端）。
- 兼容 PaddleOCR 2.x(.ocr) 与 3.x(.predict) 两套 API，输出统一归一化结构。

启动：
    uvicorn server:app --host 127.0.0.1 --port 8077
或：
    python server.py
"""

from __future__ import annotations

import base64
import io
import os
import threading
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from PIL import Image

OCR_LANG = os.environ.get("OCR_LAYOUT_LANG", "ch")


@asynccontextmanager
async def lifespan(_app: "FastAPI"):
    # 每个 worker 进程启动即预加载预测器：避免并发首请求同时触发模型初始化引发崩溃(500)，
    # 并让首批真实请求直接命中已就绪的模型。
    get_ocr()
    yield


app = FastAPI(title="nice-ocr layout service", lifespan=lifespan)

# 并发说明：本机实测 PaddleOCR(CPU 构建) 一旦「同时」推理就 native 崩溃（segfault / 连接重置）——
# 无论单进程多线程、单进程多实例，还是多进程并行都会崩。因此默认 OCR_LAYOUT_WORKERS=1 串行，
# 进程内再用锁确保任一时刻只有一个 predict。要真正并发需换并发安全的运行时（GPU 版 / RapidOCR-ONNX）。
OCR_WORKERS = max(1, int(os.environ.get("OCR_LAYOUT_WORKERS", "1")))
_ocr = None
_ocr_lock = threading.Lock()
_ocr_init_lock = threading.Lock()


class LayoutRequest(BaseModel):
    # 二选一：本机绝对/相对路径，或 base64（worker 与本服务同机时优先用 imagePath，零拷贝）。
    imagePath: str | None = None
    imageBase64: str | None = None


def _truthy(name: str, default: str = "0") -> bool:
    return os.environ.get(name, default).strip().lower() in {"1", "true", "yes", "on"}


def _build_ocr():
    """新建一个 PaddleOCR 实例（第一个实例首次调用会下载模型，数十 MB）。

    默认关闭文档方向分类 / 去扭曲 / 文字行方向三个可选子模型：
    票据基本平整、用不上，关掉可少下 3 个模型、加快首次启动、减少对模型服务器的依赖。
    需要时用环境变量 OCR_LAYOUT_ORIENT=1 打开文字行方向。
    多实例并发时建议设 OCR_LAYOUT_CPU_THREADS 限制每实例线程数，避免 CPU 过度订阅。
    """
    from paddleocr import PaddleOCR

    orient = _truthy("OCR_LAYOUT_ORIENT")
    # 注意：不要传 cpu_threads / enable_mkldnn —— 实测在本 paddle 构建 + 多 worker 下会让进程硬崩溃
    # (ConnectionReset)。限制每进程线程数改用 OMP_NUM_THREADS 环境变量（见 server.py __main__）。
    kwargs: dict[str, Any] = {
        "use_doc_orientation_classify": False,
        "use_doc_unwarping": False,
        "use_textline_orientation": orient,
    }
    # 3.x 形参；旧版（2.x）不识别这些参数 → 回退到 use_angle_cls。
    try:
        return PaddleOCR(lang=OCR_LANG, **kwargs)
    except TypeError:
        return PaddleOCR(lang=OCR_LANG, use_angle_cls=orient)


def get_ocr():
    """惰性创建本进程唯一的预测器。"""
    global _ocr
    if _ocr is None:
        with _ocr_init_lock:
            if _ocr is None:
                _ocr = _build_ocr()
    return _ocr


def _load_image(req: LayoutRequest) -> tuple[Any, int, int]:
    if req.imagePath:
        if not os.path.exists(req.imagePath):
            raise HTTPException(status_code=404, detail=f"image not found: {req.imagePath}")
        with Image.open(req.imagePath) as im:
            width, height = im.size
        return req.imagePath, width, height
    if req.imageBase64:
        raw = base64.b64decode(req.imageBase64)
        with Image.open(io.BytesIO(raw)) as im:
            width, height = im.size
        # PaddleOCR 接受 numpy 数组；避免额外依赖，落临时文件交给 imagePath 分支更稳妥。
        import tempfile

        fd, path = tempfile.mkstemp(suffix=".png")
        os.close(fd)
        Image.open(io.BytesIO(raw)).convert("RGB").save(path)
        return path, width, height
    raise HTTPException(status_code=400, detail="imagePath or imageBase64 required")


def _poly_to_box(poly: list[list[float]], width: int, height: int) -> dict[str, float]:
    xs = [float(p[0]) for p in poly]
    ys = [float(p[1]) for p in poly]
    x0, x1 = min(xs), max(xs)
    y0, y1 = min(ys), max(ys)
    return {
        "x": _clamp01(x0 / width),
        "y": _clamp01(y0 / height),
        "w": _clamp01((x1 - x0) / width),
        "h": _clamp01((y1 - y0) / height),
    }


def _clamp01(v: float) -> float:
    return max(0.0, min(1.0, v))


def _run_ocr(image_path: str) -> list[tuple[list[list[float]], str, float]]:
    """统一返回 [(poly4, text, score), ...]，兼容 2.x / 3.x。"""
    ocr = get_ocr()
    with _ocr_lock:  # 进程内串行；并行靠多 worker 进程
        return _run_ocr_with(ocr, image_path)


def _run_ocr_with(ocr, image_path: str) -> list[tuple[list[list[float]], str, float]]:
    lines: list[tuple[list[list[float]], str, float]] = []

    # 3.x: predict 返回 list[dict|Result]，字段含 rec_texts / rec_scores / rec_polys(或 dt_polys)
    if hasattr(ocr, "predict"):
        results = ocr.predict(image_path)
        for res in results or []:
            data = res if isinstance(res, dict) else getattr(res, "json", None) or getattr(res, "res", res)
            if isinstance(data, dict) and "res" in data and isinstance(data["res"], dict):
                data = data["res"]
            texts = (data or {}).get("rec_texts") or []
            scores = (data or {}).get("rec_scores") or []
            polys = (data or {}).get("rec_polys")
            if polys is None:
                polys = (data or {}).get("dt_polys") or []
            for i, poly in enumerate(polys):
                text = texts[i] if i < len(texts) else ""
                score = float(scores[i]) if i < len(scores) else 0.0
                lines.append(([[float(x), float(y)] for x, y in poly], str(text), score))
        if lines:
            return lines

    # 2.x: ocr(img, cls=True) 返回 [[ [poly, (text, score)], ... ]]
    if hasattr(ocr, "ocr"):
        try:
            results = ocr.ocr(image_path, cls=True)
        except TypeError:
            results = ocr.ocr(image_path)
        page = results[0] if results else []
        for item in page or []:
            poly, (text, score) = item[0], item[1]
            lines.append(([[float(x), float(y)] for x, y in poly], str(text), float(score)))
    return lines


@app.get("/health")
def health() -> dict[str, Any]:
    return {"status": "ok", "lang": OCR_LANG, "workers": OCR_WORKERS}


@app.post("/layout")
def layout(req: LayoutRequest) -> dict[str, Any]:
    image_path, width, height = _load_image(req)
    try:
        raw_lines = _run_ocr(image_path)
    except HTTPException:
        raise
    except BaseException as error:  # noqa: BLE001
        import traceback

        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"{type(error).__name__}: {error}") from error
    lines = [
        {
            "text": text,
            "score": round(score, 4),
            "box": _poly_to_box(poly, width, height),
            "poly": poly,
        }
        for poly, text, score in raw_lines
        if text.strip()
    ]
    return {"width": width, "height": height, "lines": lines}


if __name__ == "__main__":
    import uvicorn

    # 限制每进程 OpenMP 线程数：默认 = 核数 / 进程数，避免 N 个 worker 在多核上过度订阅、拖慢并行。
    # 用环境变量而非 paddle 的 cpu_threads kwarg（后者在本构建 + 多 worker 下会硬崩溃）；
    # spawn 出的 worker 进程继承父进程环境，故在导入 paddle 前生效。
    threads = os.environ.get("OCR_LAYOUT_CPU_THREADS") or str(
        max(1, (os.cpu_count() or OCR_WORKERS) // OCR_WORKERS)
    )
    for var in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS"):
        os.environ.setdefault(var, threads)

    # workers>1 需用 import 字符串而非 app 对象；每个 worker 进程各自预加载预测器。
    uvicorn.run(
        "server:app",
        host=os.environ.get("OCR_LAYOUT_HOST", "127.0.0.1"),
        port=int(os.environ.get("OCR_LAYOUT_PORT", "8077")),
        workers=OCR_WORKERS,
    )
