/// Maximum number of camera channels rendered in the live preview grid.
/// Matches the terminal UI and the controller's visualizer runtime config
/// so a project with extra camera channels degrades gracefully (the extra
/// channels still record but don't appear on the preview row, keeping each
/// tile large enough for the requested 16:10 box).
export const MAX_PREVIEW_CAMERAS = 3;

/**
 * Resolve which camera channels to display, in stable order, capped at
 * {@link MAX_PREVIEW_CAMERAS}. Configured channels appear first; any
 * active-but-unconfigured channels are appended so a freshly-discovered
 * stream still appears, but the cap prevents the preview row from being
 * pushed below the per-tile readability threshold.
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
