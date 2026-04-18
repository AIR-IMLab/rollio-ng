/// Maximum number of camera channels rendered side-by-side in the live
/// preview. Mirrors `rollio_types::config::MAX_PREVIEW_CAMERAS` (the
/// visualizer is already configured to subscribe to at most this many
/// channels, but the UI also enforces it as defense-in-depth so an extra
/// in-flight frame from a re-configured backend doesn't blow past the
/// 16:10 layout budget).
export const MAX_PREVIEW_CAMERAS = 3;

/**
 * Resolve which camera channels to display, in stable order.
 *
 * Configured channels are shown first, then any active-but-unconfigured
 * channels are appended (so a new stream still appears immediately).
 * The result is then truncated to {@link MAX_PREVIEW_CAMERAS} so the
 * preview row keeps room for the 16:10 per-tile box.
 */
export function resolveCameraNames(
  configuredCameraNames: readonly string[],
  activeFrameNames: readonly string[],
): string[] {
  const names = (() => {
    if (configuredCameraNames.length > 0) {
      const merged = [...configuredCameraNames];
      for (const name of activeFrameNames) {
        if (!merged.includes(name)) {
          merged.push(name);
        }
      }
      return merged;
    }

    if (activeFrameNames.length > 0) {
      return [...activeFrameNames];
    }

    return ["camera_0", "camera_1"];
  })();

  return names.slice(0, MAX_PREVIEW_CAMERAS);
}
