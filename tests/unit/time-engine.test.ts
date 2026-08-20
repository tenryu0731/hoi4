import { describe, expect, it } from 'vitest';
import {
  clockFromHours, daysInMonth, formatDate, hoursFromDate, isLeapYear,
} from '../../src/sim/time/calendar';
import { MAX_CATCHUP_TICKS, MS_PER_HOUR, TimeEngine } from '../../src/sim/time/TimeEngine';

describe('calendar', () => {
  it('starts at the scenario epoch', () => {
    const c = clockFromHours(0);
    expect(formatDate(c)).toBe('1936-01-01');
    expect(c.hour).toBe(0);
    expect(c.totalDays).toBe(0);
  });

  it('knows 1936 is a leap year and 1900 is not', () => {
    expect(isLeapYear(1936)).toBe(true);
    expect(isLeapYear(1939)).toBe(false);
    expect(isLeapYear(1900)).toBe(false);
    expect(isLeapYear(2000)).toBe(true);
    expect(daysInMonth(1936, 2)).toBe(29);
    expect(daysInMonth(1937, 2)).toBe(28);
  });

  it('places 29 February 1936 exactly 59 days in', () => {
    const c = clockFromHours(59 * 24);
    expect(formatDate(c)).toBe('1936-02-29');
  });

  it('rolls over the year after a full leap year', () => {
    const c = clockFromHours(366 * 24);
    expect(formatDate(c)).toBe('1937-01-01');
  });

  it('round-trips hoursFromDate against clockFromHours', () => {
    const dates: [number, number, number][] = [
      [1936, 1, 1], [1936, 2, 29], [1936, 12, 31], [1937, 3, 1],
      [1939, 9, 1], [1940, 2, 29], [1944, 6, 6], [1948, 1, 1],
    ];
    for (const [y, m, d] of dates) {
      const h = hoursFromDate(y, m, d, 13);
      const c = clockFromHours(h);
      expect([c.year, c.month, c.day, c.hour]).toEqual([y, m, d, 13]);
    }
  });

  it('advances day-of-week by one per day', () => {
    const a = clockFromHours(hoursFromDate(1939, 9, 1));
    const b = clockFromHours(hoursFromDate(1939, 9, 2));
    expect(b.dayOfWeek).toBe((a.dayOfWeek + 1) % 7);
  });
});

describe('TimeEngine', () => {
  it('does not tick while paused', () => {
    const te = new TimeEngine();
    let ticks = 0;
    te.on(() => ticks++);
    te.speed = 0;
    te.advance(5000);
    expect(ticks).toBe(0);
    expect(te.hours).toBe(0);
  });

  it('converts real milliseconds into hours at the configured rate', () => {
    const te = new TimeEngine();
    let ticks = 0;
    te.on(() => ticks++);
    te.speed = 1;
    const per = MS_PER_HOUR[1];
    // advance() clamps a single dt to 1000ms, so feed it in frame-sized slices.
    for (let i = 0; i < 10; i++) te.advance(per);
    expect(ticks).toBe(10);
    expect(te.hours).toBe(10);
  });

  it('keeps every speed step a step, and none of them a chasm', () => {
    // The ladder is what the player actually experiences, so it is asserted
    // rather than left to whatever the constants happen to be. Slowest is a
    // few seconds to the day; fastest clears a year in under a minute; and no
    // single step more than triples, which is what made the old ladder read as
    // "only the top one works".
    const secondsPerDay = (speed: number) => (MS_PER_HOUR[speed] * 24) / 1000;
    expect(secondsPerDay(1)).toBeGreaterThan(3);
    expect(secondsPerDay(1)).toBeLessThan(9);
    expect(secondsPerDay(5)).toBeLessThan(0.2);
    for (let s = 2; s <= 5; s++) {
      const jump = MS_PER_HOUR[s - 1] / MS_PER_HOUR[s];
      expect(jump, `speed ${s - 1} -> ${s}`).toBeGreaterThan(1.7);
      expect(jump, `speed ${s - 1} -> ${s}`).toBeLessThan(3);
    }
  });

  it('caps catch-up work so a stalled frame cannot spiral', () => {
    const te = new TimeEngine();
    let ticks = 0;
    te.on(() => ticks++);
    te.speed = 5;
    te.advance(1_000_000);
    expect(ticks).toBeLessThanOrEqual(MAX_CATCHUP_TICKS);
    expect(te.lastTickCount).toBe(ticks);
  });

  it('produces identical state regardless of the speed it was run at', () => {
    const run = (speed: 1 | 2 | 3 | 4 | 5, frameMs: number) => {
      const te = new TimeEngine();
      const days: string[] = [];
      te.on((ctx) => {
        if (ctx.newDay) days.push(formatDate(ctx.clock));
      });
      te.speed = speed;
      for (let i = 0; i < 100000; i++) {
        te.advance(frameMs);
        if (te.hours >= 24 * 30) break;
      }
      return days.slice(0, 30);
    };
    const slow = run(1, 100);
    const fast = run(5, 16);
    expect(slow.length).toBe(30);
    expect(fast).toEqual(slow);
  });

  it('fires day, week, month and year boundaries at the right cadence', () => {
    const te = new TimeEngine();
    let days = 0, weeks = 0, months = 0, years = 0;
    te.on((ctx) => {
      if (ctx.newDay) days++;
      if (ctx.newWeek) weeks++;
      if (ctx.newMonth) months++;
      if (ctx.newYear) years++;
    });
    te.step(366 * 24); // all of 1936
    expect(days).toBe(366);
    expect(months).toBe(12);
    expect(years).toBe(1);
    // Day 0 is itself a week boundary, so only days 7..364 fire within the year.
    expect(weeks).toBe(52);
  });

  it('resets the accumulator on a speed change so no tick is lost or doubled', () => {
    const te = new TimeEngine();
    let ticks = 0;
    te.on(() => ticks++);
    te.speed = 1;
    te.advance(MS_PER_HOUR[1] * 0.9); // 90% of the way to a tick
    expect(ticks).toBe(0);
    te.speed = 2;                     // discards the partial hour
    expect(te.alpha).toBe(0);
    // Derived from the ladder rather than written out, so retuning a speed
    // cannot silently turn this into a test of nothing.
    const per = MS_PER_HOUR[2];
    te.advance(per * 0.9);
    expect(ticks).toBe(0); // still short of a whole hour
    te.advance(per * 0.9);
    expect(ticks).toBe(1);
  });

  it('reports interpolation alpha between ticks', () => {
    const te = new TimeEngine();
    te.speed = 1;
    te.advance(MS_PER_HOUR[1] / 2);
    expect(te.alpha).toBeCloseTo(0.5, 5);
  });

  it('steps deterministically without real time', () => {
    const te = new TimeEngine(hoursFromDate(1939, 8, 31, 0));
    te.step(24);
    expect(formatDate(te.clock)).toBe('1939-09-01');
  });
});
