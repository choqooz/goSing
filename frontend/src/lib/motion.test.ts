import { describe, expect, it } from "vitest";
import { scrollBehavior } from "@/lib/motion";

describe("scrollBehavior", () => {
  it("uses instant scrolling when motion is reduced", () => {
    expect(scrollBehavior(true)).toBe("auto");
  });

  it("preserves smooth lyric scrolling otherwise", () => {
    expect(scrollBehavior(false)).toBe("smooth");
  });
});
