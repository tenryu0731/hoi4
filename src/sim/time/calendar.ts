/** Real Gregorian calendar arithmetic, hour resolution. Epoch = 1936-01-01 00:00. */

export const EPOCH_YEAR = 1936;
export const HOURS_PER_DAY = 24;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export interface GameClock {
  /** Hours elapsed since epoch. The single source of truth. */
  totalHours: number;
  year: number;
  /** 1-12 */
  month: number;
  /** 1-31 */
  day: number;
  /** 0-23 */
  hour: number;
  /** 0 = Wednesday (1936-01-01 was a Wednesday); used to stagger AI work. */
  dayOfWeek: number;
  /** Days elapsed since epoch. */
  totalDays: number;
}

export function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) return 29;
  return DAYS_IN_MONTH[month - 1];
}

export function daysInYear(year: number): number {
  return isLeapYear(year) ? 366 : 365;
}

/** Converts hours-since-epoch into a fully populated clock. */
export function clockFromHours(totalHours: number): GameClock {
  const totalDays = Math.floor(totalHours / HOURS_PER_DAY);
  const hour = totalHours - totalDays * HOURS_PER_DAY;

  let remaining = totalDays;
  let year = EPOCH_YEAR;
  for (;;) {
    const len = daysInYear(year);
    if (remaining < len) break;
    remaining -= len;
    year++;
  }
  let month = 1;
  for (;;) {
    const len = daysInMonth(year, month);
    if (remaining < len) break;
    remaining -= len;
    month++;
  }
  return {
    totalHours,
    year,
    month,
    day: remaining + 1,
    hour,
    dayOfWeek: ((totalDays % 7) + 7) % 7,
    totalDays,
  };
}

/** Inverse of clockFromHours; useful for scenario setup and tests. */
export function hoursFromDate(year: number, month: number, day: number, hour = 0): number {
  let days = 0;
  for (let y = EPOCH_YEAR; y < year; y++) days += daysInYear(y);
  for (let m = 1; m < month; m++) days += daysInMonth(year, m);
  days += day - 1;
  return days * HOURS_PER_DAY + hour;
}

export function formatDate(c: GameClock): string {
  const mm = String(c.month).padStart(2, '0');
  const dd = String(c.day).padStart(2, '0');
  return `${c.year}-${mm}-${dd}`;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function formatDateLong(c: GameClock): string {
  return `${c.day} ${MONTH_NAMES[c.month - 1]} ${c.year}`;
}
