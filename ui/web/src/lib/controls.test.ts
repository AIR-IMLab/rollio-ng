import { describe, expect, it } from "vitest";
import { actionForInput } from "./controls";

const episodeKeyBindings = {
  startKey: "s",
  stopKey: "e",
  keepKey: "k",
  discardKey: "x",
};

describe("actionForInput", () => {
  it("preserves debug and episode shortcuts", () => {
    expect(actionForInput("d", episodeKeyBindings)).toBe("toggle_debug");
    expect(actionForInput("s", episodeKeyBindings)).toBe("episode_start");
    expect(actionForInput("e", episodeKeyBindings)).toBe("episode_stop");
    expect(actionForInput("k", episodeKeyBindings)).toBe("episode_keep");
    expect(actionForInput("x", episodeKeyBindings)).toBe("episode_discard");
  });

  it("ignores unrelated keys", () => {
    expect(actionForInput("q", episodeKeyBindings)).toBeNull();
  });
});
