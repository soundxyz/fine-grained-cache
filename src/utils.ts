export function getRemainingSeconds(date: Date) {
  return Math.max(Math.ceil((date.getTime() - Date.now()) / 1000), 0);
}
