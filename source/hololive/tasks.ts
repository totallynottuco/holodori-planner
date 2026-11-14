export interface PlannerTask {
  id: string;
  title: string;
  notes: string;
  category: "permanent" | "events" | "custom";
  repeat: "none" | "daily" | "weekly";
  dueAt: string | null;
  doneAt: string | null;
  snoozedUntil: string | null;
  /** Seelie's custom reminder interval and recurrence anchor. Optional for prior app exports. */
  recurrenceDays?: number;
  recurrenceMode?: "original" | "completed";
}
export function localDay(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}
export function calendarDifference(left: Date, right: Date) {
  const ordinal = (date: Date) =>
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((ordinal(left) - ordinal(right)) / 86400000);
}
export function addCalendarDays(date: Date, days: number) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}
export function taskRecurrence(task: PlannerTask) {
  return task.recurrenceDays ?? (task.repeat === "weekly" ? 7 : 1);
}
/** Port of By.toggleDone, captured Seelie source lines 31030–31056.
 * New reminders retain the original next-date workflow; legacy reminders retain their saved behavior.
 */
export function toggleTask(task: PlannerTask, now = new Date()): PlannerTask {
  if (task.recurrenceDays === undefined || !task.dueAt)
    return {
      ...task,
      doneAt: taskWindow(task, now).done ? null : now.toISOString(),
    };
  const due = new Date(task.dueAt),
    today = localDay(now),
    step = taskRecurrence(task);
  const difference = calendarDifference(today, due);
  const next =
    difference < 0
      ? addCalendarDays(due, -step)
      : task.recurrenceMode === "completed"
        ? addCalendarDays(today, step)
        : addCalendarDays(due, (Math.floor(difference / step) + 1) * step);
  return {
    ...task,
    dueAt: next.toISOString(),
    doneAt: difference < 0 ? null : now.toISOString(),
    snoozedUntil: null,
  };
}
export function recurrenceLabel(task: PlannerTask, now = new Date()) {
  const due = task.dueAt ? new Date(task.dueAt) : localDay(now);
  const difference = calendarDifference(localDay(now), due);
  return difference > 0
    ? "overdue"
    : difference === 0
      ? "today"
      : difference === -1
        ? "tomorrow"
        : due.toLocaleDateString("en", { weekday: "short" }).toLowerCase();
}
/** Repeats follow local calendar days so a daylight-saving change does not shift reset time. */
export function taskWindow(task: PlannerTask, now = new Date()) {
  if (task.recurrenceDays !== undefined && task.dueAt) {
    const due = new Date(task.dueAt);
    return { done: calendarDifference(localDay(now), due) < 0, due };
  }
  if (task.repeat === "none" || !task.dueAt)
    return {
      done: !!task.doneAt,
      due: task.dueAt ? new Date(task.dueAt) : null,
    };
  const next = new Date(task.dueAt),
    step = task.repeat === "weekly" ? 7 : 1;
  const estimate = Math.floor(
    (now.getTime() - next.getTime()) / 86400000 / step,
  );
  next.setDate(next.getDate() + estimate * step);
  while (next <= now) next.setDate(next.getDate() + step);
  const start = new Date(next);
  start.setDate(start.getDate() - step);
  return { done: !!task.doneAt && new Date(task.doneAt) >= start, due: next };
}
export function deadline(date: Date | null, now = new Date()) {
  if (!date) return "";
  const minutes = Math.ceil((date.getTime() - now.getTime()) / 60000);
  if (minutes <= 0) return "Due";
  const days = Math.floor(minutes / 1440),
    hours = Math.floor((minutes % 1440) / 60),
    mins = minutes % 60;
  return days
    ? `${days}d ${hours}h`
    : hours
      ? `${hours}h ${mins}m`
      : `${mins}m`;
}
