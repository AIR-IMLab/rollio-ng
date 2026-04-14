import { describe, expect, it } from "vitest";
import {
  WIDE_LAYOUT_MIN_WIDTH,
  buildPreviewNegotiationKey,
  isWideLayout,
  negotiatePreviewDimensions,
} from "./layout";

describe("layout helpers", () => {
  it("switches between narrow and wide layouts", () => {
    expect(isWideLayout(WIDE_LAYOUT_MIN_WIDTH - 1)).toBe(false);
    expect(isWideLayout(WIDE_LAYOUT_MIN_WIDTH)).toBe(true);
  });

  it("negotiates preview dimensions in device pixels", () => {
    expect(negotiatePreviewDimensions({ width: 320, height: 180 }, 2)).toEqual({
      width: 640,
      height: 360,
    });
  });

  it("builds stable preview negotiation keys", () => {
    expect(
      buildPreviewNegotiationKey(1280, 720, {
        width: 640,
        height: 360,
      }),
    ).toBe("1280x720:640x360");
  });
});
