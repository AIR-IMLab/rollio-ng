import { describe, expect, it } from "vitest";
import { MAX_PREVIEW_CAMERAS, resolveCameraNames } from "./camera-layout";

describe("resolveCameraNames", () => {
  it("keeps configured streams visible", () => {
    expect(
      resolveCameraNames(
        ["camera_d435i_rgb", "camera_d435i_depth"],
        ["camera_d435i_rgb"],
      ),
    ).toEqual(["camera_d435i_rgb", "camera_d435i_depth"]);
  });

  it("appends unexpected active streams", () => {
    expect(
      resolveCameraNames(["camera_a"], ["camera_a", "camera_b"]),
    ).toEqual(["camera_a", "camera_b"]);
  });

  it(`caps the preview row at ${MAX_PREVIEW_CAMERAS} channels`, () => {
    const configured = ["cam_a", "cam_b", "cam_c", "cam_d", "cam_e"];
    const names = resolveCameraNames(configured, []);
    expect(names).toHaveLength(MAX_PREVIEW_CAMERAS);
    expect(names).toEqual(configured.slice(0, MAX_PREVIEW_CAMERAS));
  });

  it("falls back to placeholders when nothing is configured or active", () => {
    expect(resolveCameraNames([], [])).toEqual(["camera_0", "camera_1"]);
  });
});
