export const WIDE_LAYOUT_MIN_WIDTH = 1200;
const MIN_PREVIEW_DIMENSION = 1;
const MAX_PREVIEW_DIMENSION = 4096;

export interface PreviewDimensions {
  width: number;
  height: number;
}

export function isWideLayout(width: number): boolean {
  return width >= WIDE_LAYOUT_MIN_WIDTH;
}

export function clampPreviewDimension(value: number): number {
  return Math.max(
    MIN_PREVIEW_DIMENSION,
    Math.min(MAX_PREVIEW_DIMENSION, Math.round(value)),
  );
}

export function negotiatePreviewDimensions(
  tileSize: PreviewDimensions,
  devicePixelRatio = 1,
): PreviewDimensions {
  return {
    width: clampPreviewDimension(tileSize.width * devicePixelRatio),
    height: clampPreviewDimension(tileSize.height * devicePixelRatio),
  };
}

export function buildPreviewNegotiationKey(
  viewportWidth: number,
  viewportHeight: number,
  previewSize: PreviewDimensions,
): string {
  return [
    `${Math.round(viewportWidth)}x${Math.round(viewportHeight)}`,
    `${previewSize.width}x${previewSize.height}`,
  ].join(":");
}
