import assert from "node:assert/strict";
import { test } from "node:test";
import { formatLastCheck } from "../../src/lib/update-time.ts";

const secs = (d) => Math.floor(d.getTime() / 1000);
const now = new Date(2030, 5, 15, 12, 0, 0);

test("no marker reads as never", () => {
  assert.equal(formatLastCheck(null, now), "never");
});

test("today and yesterday are named, older checks show the date", () => {
  assert.match(formatLastCheck(secs(new Date(2030, 5, 15, 9, 5)), now), /^today \S+/);
  assert.match(formatLastCheck(secs(new Date(2030, 5, 14, 23, 59)), now), /^yesterday \S+/);
  const older = formatLastCheck(secs(new Date(2030, 5, 13, 9, 5)), now);
  assert.doesNotMatch(older, /^(today|yesterday)/);
  assert.match(older, /2030|30/);
});

test("yesterday means the calendar day, not the last 24 hours", () => {
  const justAfterMidnight = new Date(2030, 5, 15, 0, 10);
  assert.match(formatLastCheck(secs(new Date(2030, 5, 14, 23, 50)), justAfterMidnight), /^yesterday/);
});
