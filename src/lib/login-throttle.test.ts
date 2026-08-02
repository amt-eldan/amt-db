import { describe, expect, it } from "vitest";
import {
  MAX_FAILURES,
  WINDOW_MINUTES,
  throttleVerdict,
  windowStart,
} from "./login-throttle";

const now = new Date("2026-08-02T12:00:00Z");
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);

describe("windowStart", () => {
  it("opens the window WINDOW_MINUTES before now", () => {
    expect(windowStart(now)).toEqual(minutesAgo(WINDOW_MINUTES));
  });
});

describe("throttleVerdict", () => {
  it("allows an attempt below the failure limit", () => {
    expect(throttleVerdict(0, null, now)).toEqual({ allowed: true });
    expect(throttleVerdict(MAX_FAILURES - 1, minutesAgo(1), now)).toEqual({ allowed: true });
  });

  it("locks once the limit is reached", () => {
    const verdict = throttleVerdict(MAX_FAILURES, minutesAgo(1), now);
    expect(verdict.allowed).toBe(false);
  });

  it("reports the minutes until the oldest failure ages out", () => {
    // Oldest failure 5 minutes ago → 10 of the 15 window minutes are left.
    expect(throttleVerdict(MAX_FAILURES, minutesAgo(5), now)).toEqual({
      allowed: false,
      retryAfterMinutes: WINDOW_MINUTES - 5,
    });
  });

  it("never reports zero minutes remaining", () => {
    const verdict = throttleVerdict(MAX_FAILURES, minutesAgo(WINDOW_MINUTES - 0.2), now);
    expect(verdict).toEqual({ allowed: false, retryAfterMinutes: 1 });
  });

  it("lifts the lock by itself once the window has passed", () => {
    // Sliding window: no cleanup job is needed to unlock an IP.
    expect(throttleVerdict(MAX_FAILURES, minutesAgo(WINDOW_MINUTES), now)).toEqual({
      allowed: true,
    });
    expect(throttleVerdict(MAX_FAILURES * 3, minutesAgo(WINDOW_MINUTES + 60), now)).toEqual({
      allowed: true,
    });
  });

  it("allows the attempt when the count has no timestamp to lock against", () => {
    expect(throttleVerdict(MAX_FAILURES, null, now)).toEqual({ allowed: true });
  });
});
