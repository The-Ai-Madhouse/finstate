import { describe, expect, it } from 'vitest';
import { resolveAll } from './classify';
import { demoData } from './demo';
import { addMonths, bufferSuggestion, goalPlan, goalsOverview, monthsUntil, savingsCapacity } from './goals';
import type { Goal } from './types';

const goal = (p: Partial<Goal>): Goal => ({ id: 'g', name: 'Japan', kind: 'travel', target: 45_000_00, saved: 3_000_00, priority: 1, createdAt: '2026-11-01', ...p });

describe('opsparingsmål', () => {
  it('counts whole months to the deadline', () => {
    expect(monthsUntil('2026-11-23', '2027-06-01')).toBe(6);
    expect(monthsUntil('2026-11-23', '2027-06-23')).toBe(7);
    expect(monthsUntil('2026-11-23', '2026-12-01')).toBe(1);
    expect(monthsUntil('2026-11-23', '2026-11-01')).toBe(0);
    expect(addMonths('2027-01-31', 1)).toBe('2027-02-28');
  });

  it('works out what it takes per month – and when you get there with your own plan', () => {
    const p = goalPlan(goal({ deadline: '2027-06-23', monthly: 5_000_00 }), '2026-11-23');
    expect([p.target, p.left, p.monthsLeft, p.needPerMonth]).toEqual([45_000_00, 42_000_00, 7, 6_000_00]);
    expect([p.monthsAtPlan, p.reachedAt, p.lateBy, p.status]).toEqual([9, '2027-08-23', 2, 'behind']);
    expect(goalPlan(goal({ deadline: '2027-06-23', monthly: 6_000_00 }), '2026-11-23').status).toBe('ontrack');
    expect(goalPlan(goal({ deadline: '2027-06-23' }), '2026-11-23').status).toBe('noplan');
    expect(goalPlan(goal({ saved: 45_000_00 }), '2026-11-23').status).toBe('done');
    expect(goalPlan(goal({ deadline: '2026-10-01' }), '2026-11-23').status).toBe('overdue');
    // Rund op til hele kroner: 10.000 kr. over 3 måneder = 3.333,34 → 3.334 kr.
    expect(goalPlan(goal({ target: 10_000_00, saved: 0, deadline: '2027-02-23' }), '2026-11-23').needPerMonth).toBe(3_334_00);
  });

  it('uses the sum of the budget lines as the target', () => {
    const p = goalPlan(goal({ target: 0, costs: [{ id: 'a', label: 'Fly', amount: 9_000_00 }, { id: 'b', label: 'Hotel', amount: 14_000_00 }] }), '2026-11-23');
    expect(p.target).toBe(23_000_00);
  });

  it('measures realism against what you have left each month in your bank data', () => {
    const d = demoData();
    const cap = savingsCapacity(d, resolveAll(d))!;
    // Demodata: hele 2025 og januar–juni 2026 → de seneste 6 hele måneder.
    expect([cap.months, cap.from, cap.to]).toEqual([6, '2026-01', '2026-06']);
    expect(cap.net).toBe(cap.income - cap.expense);
    const o = goalsOverview([goal({ deadline: '2027-06-23' })], '2026-11-23', { ...cap, net: 10_000_00 });
    expect([o.needPerMonth, o.verdict]).toEqual([6_000_00, 'realistic']);
    expect(goalsOverview([goal({ deadline: '2027-06-23' })], '2026-11-23', { ...cap, net: 6_500_00 }).verdict).toBe('tight');
    expect(goalsOverview([goal({ deadline: '2027-06-23' })], '2026-11-23', { ...cap, net: 4_000_00 }).verdict).toBe('unrealistic');
    expect(goalsOverview([goal({ deadline: '2027-06-23' })], '2026-11-23').verdict).toBe('unknown');
    expect(bufferSuggestion(10_218_00)).toBe(30_654_00);
  });
});
