export function currentWindowId(intervalMinutes: number, now = Date.now()): string {
  if (intervalMinutes !== 1 && intervalMinutes !== 15 && intervalMinutes !== 30) {
    throw new Error("pitch interval must be 1, 15 or 30 minutes");
  }
  return String(Math.floor(now / (intervalMinutes * 60 * 1000))).padStart(10, "0");
}
