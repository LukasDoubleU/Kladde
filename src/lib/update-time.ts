/** When the last update check completed, for the settings page: "today 14:03", "yesterday 09:12", a date, or "never". */
export function formatLastCheck(seconds: number | null, now: Date = new Date()): string {
  if (seconds === null) return "never";
  const at = new Date(seconds * 1000);
  const time = at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const days = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000;
  // Calendar days, not 24 h spans: 23:50 yesterday is "yesterday" at 00:10.
  const ago = days(now) - days(at);
  if (ago === 0) return `today ${time}`;
  if (ago === 1) return `yesterday ${time}`;
  return `${at.toLocaleDateString()} ${time}`;
}
