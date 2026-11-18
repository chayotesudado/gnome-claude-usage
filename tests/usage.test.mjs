import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..");
const U = await import(join(dir, "lib/usage.js"));

test("usage report: both windows, rounded and clamped", () => {
  const u = U.parseUsage(JSON.stringify({
    five_hour: { utilization: 9.4, resets_at: "2026-11-19T00:39:59.898871+00:00" },
    seven_day: { utilization: 130, resets_at: null },
  }));
  assert.equal(u.session.percent, 9);
  assert.equal(u.session.resetsAt, Date.parse("2026-11-19T00:39:59.898Z"));
  assert.equal(u.weekly.percent, 100);
  assert.equal(u.weekly.resetsAt, null);
});

test("usage report: missing windows are null", () => {
  assert.deepEqual(U.parseUsage('{"five_hour":null}'), { session: null, weekly: null });
});

test("credentials: token and expiry; nothing else", () => {
  const c = U.parseCredentials(JSON.stringify({ claudeAiOauth: {
    accessToken: "t", refreshToken: "r", expiresAt: 5, subscriptionType: "max" } }));
  assert.deepEqual(c, { token: "t", expiresAt: 5 });
  assert.equal(U.parseCredentials("{}"), null);
});

test("levels, errors, countdown", () => {
  assert.equal(U.level(74), "normal");
  assert.equal(U.level(75), "warning");
  assert.equal(U.level(90), "critical");
  assert.equal(U.errorForStatus(401), "expired");
  assert.equal(U.errorForStatus(429), "rate-limited");
  assert.equal(U.errorForStatus(500), "unavailable");
  assert.deepEqual(U.untilParts(0 + 61 * 60000 + 1, 0), { hours: 1, minutes: 2 });
  assert.deepEqual(U.untilParts(0, 10), { hours: 0, minutes: 0 });
});

test("the token is never logged", () => {
  const src = readFileSync(join(dir, "extension.js"), "utf8");
  assert.doesNotMatch(src, /(log|logError|console\.\w+|print)\([^)]*token/i);
});
