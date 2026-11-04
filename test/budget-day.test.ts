import { expect, test } from 'bun:test';
import { BudgetCalendar } from '../src/scheduler/budget-day';

test('budget timezone defaults to the local timezone and rejects invalid settings', () => {
  expect(new BudgetCalendar().timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  expect(() => new BudgetCalendar('Mars/Olympus')).toThrow('Invalid budget timezone');
});
test('Kuala Lumpur budget days reset at local midnight, not midnight UTC', () => {
  const calendar = new BudgetCalendar('Asia/Kuala_Lumpur');
  expect(calendar.day(Date.parse('2026-11-04T15:59:59Z'))).toBe('2026-11-04');
  expect(calendar.day(Date.parse('2026-11-04T16:00:00Z'))).toBe('2026-11-05');
  expect(calendar.day(Date.parse('2026-11-05T00:00:00Z'))).toBe('2026-11-05');
});
test('budget day boundaries follow daylight-saving changes', () => {
  const calendar = new BudgetCalendar('America/New_York');
  expect(calendar.day(Date.parse('2026-03-08T04:59:59Z'))).toBe('2026-03-07');
  expect(calendar.day(Date.parse('2026-03-08T05:00:00Z'))).toBe('2026-03-08');
  expect(calendar.day(Date.parse('2026-03-09T03:59:59Z'))).toBe('2026-03-08');
  expect(calendar.day(Date.parse('2026-03-09T04:00:00Z'))).toBe('2026-03-09');
});

test('indexed budget windows cover the 23-hour and 25-hour DST days', () => {
  const calendar = new BudgetCalendar('America/New_York');
  const spring = calendar.window(Date.parse('2026-03-08T17:00:00Z'));
  expect(spring.end - spring.start).toBe(23 * 3600000);
  expect(new Date(spring.start).toISOString()).toBe('2026-03-08T05:00:00.000Z');
  const autumn = calendar.window(Date.parse('2026-11-01T17:00:00Z'));
  expect(autumn.end - autumn.start).toBe(25 * 3600000);
});
