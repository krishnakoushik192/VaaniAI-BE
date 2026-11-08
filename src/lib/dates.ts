// "Today" and "this week" follow India time (IST, UTC+5:30), not the server's
// clock: Vercel servers run in UTC, which would reset the counters at 5:30 AM.
const IST_OFFSET_MS = 330 * 60 * 1000;

const toIST = (date: Date) => new Date(date.getTime() + IST_OFFSET_MS);

/** "2026-11-08": the IST calendar day. */
export function istDayKey(date: Date = new Date()): string {
  return toIST(date).toISOString().slice(0, 10);
}

/** The IST date of the Monday that starts this week, e.g. "2026-11-02". */
export function istWeekKey(date: Date = new Date()): string {
  const d = toIST(date);
  const daysSinceMonday = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - daysSinceMonday);
  return d.toISOString().slice(0, 10);
}
