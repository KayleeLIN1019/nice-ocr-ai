"use client";

import { ImageOff, Maximize2, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { clampViewerZoom, regionStyle, viewportForRegion, type ImageRegionBox } from "@/components/ui/image-region";
import { cn } from "@/lib/utils";

const STEP = 0.25;
/** 滚轮/触摸板捏合每档步长：取按钮步长的一半，手感更可控。 */
const WHEEL_STEP = STEP / 2;
/** 工具栏快捷缩放倍数。 */
const QUICK_ZOOMS = [0.5, 1, 2, 4] as const;
/** 画布内边距（与 inset-4 对应），用于把视口中心换算到缩放坐标系。 */
const CANVAS_INSET = 16;

export interface ImageRegion {
  id: string;
  label?: string;
  box: ImageRegionBox;
  tone?: "active" | "muted" | "flagged";
}

/**
 * 原图查看器：缩放（按钮 / Ctrl+滚轮）+ 在透明画布内自由拖拽平移。
 */
export function ImageViewer({
  src,
  alt,
  className,
  regions = [],
  activeRegionId,
  targetRegionId,
  onRegionSelect,
}: {
  src: string | null;
  alt: string;
  className?: string;
  regions?: ImageRegion[];
  activeRegionId?: string | null;
  targetRegionId?: string | null;
  onRegionSelect?: (id: string) => void;
}) {
  const [zoom, setZoom] = useState(1);
  const [error, setError] = useState(false);
  const [panning, setPanning] = useState(false);
  const [prevSrc, setPrevSrc] = useState(src);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 });
  const canvasRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const drag = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  // 最近一次鼠标在画布内的位置，作为按钮/快捷倍数缩放的锚点（点击时鼠标已不在图上）。
  const anchorRef = useRef<{ x: number; y: number } | null>(null);
  // 镜像最新 zoom/pan/imageSize，供原生 wheel 监听与稳定的 zoomTo 在事件回调中读取（无需重绑事件）。
  // 在 effect 中同步而非 render 期写入，事件总在提交后触发，读到的即最新值。
  const zoomRef = useRef(zoom);
  const panRef = useRef(pan);
  const imageSizeRef = useRef(imageSize);
  useEffect(() => {
    zoomRef.current = zoom;
    panRef.current = pan;
    imageSizeRef.current = imageSize;
  }, [zoom, pan, imageSize]);

  // 切换图片时重置缩放与错误态（渲染期同步调整，避免 effect 级联渲染）。
  if (src !== prevSrc) {
    setPrevSrc(src);
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setImageSize({ width: 0, height: 0 });
    setError(false);
  }

  const canPan = Boolean(src && !error);
  const activeRegion = useMemo(() => regions.find((region) => region.id === activeRegionId), [activeRegionId, regions]);
  const updateImageSize = useCallback(() => {
    const img = imageRef.current;
    if (!img) return;
    setImageSize({ width: img.clientWidth, height: img.clientHeight });
  }, []);

  // 统一缩放入口：以鼠标焦点为锚点缩放（同步调整 pan，使锚点下的内容不动）。
  // anchor 为画布内坐标；缺省时退回视口中心。供按钮、快捷倍数与滚轮共用。
  const zoomTo = useCallback((next: number, anchor?: { x: number; y: number } | null) => {
    const z0 = zoomRef.current;
    const z1 = clampViewerZoom(next);
    if (z1 === z0) return;
    const canvas = canvasRef.current;
    const size = imageSizeRef.current;
    if (canvas && size.width) {
      const rect = canvas.getBoundingClientRect();
      const ratio = z1 / z0;
      // 锚点（画布内坐标）：传入则围绕鼠标焦点缩放，缺省退回视口中心。
      const sx = anchor ? anchor.x : rect.width / 2;
      const sy = anchor ? anchor.y : rect.height / 2;
      // 换算到缩放坐标系：水平 flex 居中偏移为 (rect.width-size.width)/2，垂直顶部内边距为 CANVAS_INSET。
      const qx = sx - rect.width / 2 + size.width / 2;
      const qy = sy - CANVAS_INSET;
      const p0 = panRef.current;
      setPan({ x: qx - ratio * (qx - p0.x), y: qy - ratio * (qy - p0.y) });
    }
    setZoom(z1);
  }, []);

  // Ctrl+滚轮 / 触摸板捏合缩放：必须用原生「非 passive」监听，React 合成 onWheel 是 passive，
  // preventDefault 无效会导致整页一起缩放。这里只缩放画布内图片，并阻止浏览器默认页面缩放。
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    function onWheel(event: WheelEvent) {
      if (!event.ctrlKey) return;
      event.preventDefault();
      // 按方向定步长缩放（按钮步长的一半），以鼠标焦点为锚点，触摸板捏合不再骤变。
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      anchorRef.current = anchor;
      zoomTo(zoomRef.current - Math.sign(event.deltaY) * WHEEL_STEP, anchor);
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomTo]);

  useEffect(() => {
    if (!targetRegionId) return;
    const targetId = targetRegionId.split(":")[0];
    const region = regions.find((item) => item.id === targetId);
    const canvas = canvasRef.current;
    if (!region || !canvas || !imageSize.width || !imageSize.height) return;

    const canvasRect = canvas.getBoundingClientRect();
    const viewport = viewportForRegion(region.box, imageSize, { width: canvasRect.width, height: canvasRect.height });
    setZoom(viewport.zoom);
    setPan(viewport.pan);
  }, [targetRegionId, regions, imageSize]);

  useEffect(() => {
    const img = imageRef.current;
    if (!img || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateImageSize);
    observer.observe(img);
    updateImageSize();
    return () => observer.disconnect();
  }, [src, updateImageSize]);

  function onPointerDown(event: React.PointerEvent) {
    const el = canvasRef.current;
    if (!el || !canPan) return;
    drag.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
    setPanning(true);
    el.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: React.PointerEvent) {
    const el = canvasRef.current;
    if (el) {
      const rect = el.getBoundingClientRect();
      anchorRef.current = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    }
    if (!drag.current) return;
    setPan({
      x: drag.current.panX + event.clientX - drag.current.x,
      y: drag.current.panY + event.clientY - drag.current.y,
    });
  }

  function endPan(event: React.PointerEvent) {
    const el = canvasRef.current;
    drag.current = null;
    setPanning(false);
    if (el?.hasPointerCapture(event.pointerId)) el.releasePointerCapture(event.pointerId);
  }

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="flex items-center gap-1 border-b border-border px-3 py-2">
        <button
          type="button"
          aria-label="放大"
          onClick={() => zoomTo(zoomRef.current + STEP, anchorRef.current)}
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ZoomIn size={15} />
        </button>
        <button
          type="button"
          aria-label="缩小"
          onClick={() => zoomTo(zoomRef.current - STEP, anchorRef.current)}
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ZoomOut size={15} />
        </button>
        <button
          type="button"
          aria-label="适应窗口"
          onClick={() => {
            setZoom(1);
            setPan({ x: 0, y: 0 });
          }}
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Maximize2 size={15} />
        </button>
        <span className="ml-1 w-11 text-xs tabular-nums text-muted-foreground">{Math.round(zoom * 100)}%</span>
        <div className="ml-1 flex items-center gap-0.5">
          {QUICK_ZOOMS.map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => zoomTo(value, anchorRef.current)}
              className={cn(
                "rounded px-1.5 py-0.5 text-[11px] tabular-nums transition-colors",
                Math.abs(zoom - value) < 0.01
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {value * 100}%
            </button>
          ))}
        </div>
        <span className="ml-auto text-[11px] text-muted-foreground">Ctrl+滚轮缩放 · 放大后可拖拽</span>
      </div>

      <div
        ref={canvasRef}
        className={cn(
          "relative min-h-0 flex-1 overflow-hidden bg-muted",
          canPan ? (panning ? "cursor-grabbing" : "cursor-grab") : "cursor-default",
        )}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPan}
        onPointerCancel={endPan}
      >
        {src && !error ? (
          <div
            // 顶部对齐而非垂直居中：竖向票据在宽度受限时高度填不满，居中会在上方挤出大片空白；
            // 紧贴工具栏向下展示更符合从上往下的阅读习惯。横向放大后仍可自由拖拽平移。
            className="pointer-events-none absolute inset-4 flex items-start justify-center"
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px)`,
            }}
          >
            <div className="relative max-h-full max-w-full origin-top-left" style={{ transform: `scale(${zoom})` }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                ref={imageRef}
                key={src}
                src={src}
                alt={alt}
                draggable={false}
                className="block max-h-full max-w-full select-none rounded border border-border bg-white object-contain shadow-sm"
                onLoad={updateImageSize}
                onError={() => setError(true)}
              />
              {imageSize.width && imageSize.height && activeRegion ? (
                <button
                  type="button"
                  aria-label={activeRegion.label ? `定位到${activeRegion.label}` : "定位到识别行"}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    onRegionSelect?.(activeRegion.id);
                  }}
                  className={cn(
                    "pointer-events-auto absolute rounded-sm border-2 bg-warning/25 shadow-[0_0_0_9999px_rgba(15,23,42,0.04)] transition-colors",
                    activeRegion.tone === "flagged" ? "border-danger-strong bg-danger/20" : "border-warning-strong",
                  )}
                  style={regionStyle(activeRegion.box, imageSize)}
                  title={activeRegion.label}
                />
              ) : null}
            </div>
          </div>
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <div className="flex flex-col items-center gap-2 text-muted-foreground">
              <ImageOff size={28} />
              <span className="text-xs">原图不可用（未上传或文件缺失）</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
