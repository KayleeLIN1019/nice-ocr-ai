const MIN_ZOOM = 0.25;
const MAX_ZOOM = 8;

export interface ImageRegionBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RegionViewport {
  width: number;
  height: number;
}

export function clampViewerZoom(value: number) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(value.toFixed(2))));
}

export function regionStyle(box: ImageRegionBox, image: RegionViewport) {
  return {
    left: box.x * image.width,
    top: box.y * image.height,
    width: box.w * image.width,
    height: box.h * image.height,
  };
}

export function viewportForRegion(box: ImageRegionBox, image: RegionViewport, canvas: RegionViewport) {
  const region = regionStyle(box, image);
  const zoom = clampViewerZoom(
    Math.min(
      3,
      Math.max(
        1.25,
        Math.min(canvas.width / Math.max(region.width * 2.2, 1), canvas.height / Math.max(region.height * 4, 1)),
      ),
    ),
  );
  const centerX = region.left + region.width / 2;
  const centerY = region.top + region.height / 2;
  return {
    zoom,
    pan: {
      x: canvas.width / 2 - centerX * zoom,
      y: canvas.height / 2 - centerY * zoom,
    },
  };
}
