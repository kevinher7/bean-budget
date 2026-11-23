import { Schema } from "effect";

import { paceCategory, periodWeeks, type CategoryPlan, type Rhythm } from "./weeks.ts";

export { periodWeeks, PlanningRhythm, tokyoDate, type Rhythm } from "./weeks.ts";

export const MAX_UNITS = 1_000_000_000_000;

export const Money = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: -MAX_UNITS, maximum: MAX_UNITS }),
);

export const Id = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,100}$/));

export const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));

export const FinancialDate = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/),
  Schema.makeFilter((value) => {
    const date = new Date(value + "T00:00:00Z");
    return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
  }),
);

export function balance(amounts: readonly number[]): number {
  const total = amounts.reduce((sum, amount) => sum + BigInt(amount), 0n);
  if (total < -BigInt(MAX_UNITS) || total > BigInt(MAX_UNITS))
    throw new RangeError("Balance exceeds supported units");
  return Number(total);
}

export const Currency = Schema.Literals(["JPY", "USD"]);

export function parseMoney(text: string, currency: typeof Currency.Type): number {
  const scale = currency === "USD" ? 2 : 0;
  const pattern = scale === 2 ? /^-?\d+(?:\.\d{1,2})?$/ : /^-?\d+$/;
  if (!pattern.test(text)) throw new RangeError("Invalid decimal money");
  const [whole = "0", fraction = ""] = text.replace(/^-/, "").split(".");
  const units =
    BigInt(whole) * (scale === 2 ? 100n : 1n) + BigInt(fraction.padEnd(scale, "0") || "0");
  return balance([Number(text.startsWith("-") ? -units : units)]);
}

export function monthStart(month: string, day: number): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || !Number.isInteger(day) || day < 1 || day > 31)
    throw new RangeError("Invalid month or start day");
  const last = new Date(month + "-01T00:00:00Z");
  last.setUTCMonth(last.getUTCMonth() + 1, 0);
  return month + "-" + String(Math.min(day, last.getUTCDate())).padStart(2, "0");
}

export function nextMonth(month: string): string {
  monthStart(month, 1);
  const date = new Date(month + "-01T00:00:00Z");
  date.setUTCMonth(date.getUTCMonth() + 1);
  const result = date.toISOString().slice(0, 7);
  if (!/^\d{4}-/.test(result)) throw new RangeError("Month exceeds supported calendar");
  return result;
}

export function periodTotals(input: {
  expectedIncome: number;
  commitments: number;
  previousUnassigned: number;
  previousRemaining: Readonly<Record<string, number>>;
  allocations: Readonly<Record<string, number>>;
  spending: Readonly<Record<string, number>>;
}) {
  const overspending = balance(Object.values(input.previousRemaining).map((n) => Math.max(0, -n)));
  const assignable = balance([
    input.expectedIncome,
    -input.commitments,
    input.previousUnassigned,
    -overspending,
  ]);
  const remaining = new Map<string, number>();
  const previous = new Map(Object.entries(input.previousRemaining));
  const allocations = new Map(Object.entries(input.allocations));
  const spending = new Map(Object.entries(input.spending));
  for (const id of new Set([
    ...Object.keys(input.previousRemaining),
    ...Object.keys(input.allocations),
    ...Object.keys(input.spending),
  ]))
    remaining.set(
      id,
      balance([
        Math.max(0, previous.get(id) ?? 0),
        allocations.get(id) ?? 0,
        -(spending.get(id) ?? 0),
      ]),
    );
  return {
    assignable,
    unassigned: balance([assignable, -balance(Object.values(input.allocations))]),
    remaining: Object.fromEntries(remaining),
    overspending,
  };
}

export interface BudgetOccurrence {
  scheduleId: string;
  accountId: string;
  date: string;
  amount: number;
  transactionId: string | null;
}

export function summarizePeriods(
  budget: {
    id: string;
    currency: typeof Currency.Type;
    firstMonth: string;
    startDay: number;
    accountIds: readonly string[];
    reservedScheduleIds: readonly string[];
  },
  targetMonth: string,
  history: readonly {
    id: string;
    date: string;
    amount: number;
    kind: string;
    status?: string | undefined;
    transferId?: string | null | undefined;
    categoryId?: string | null | undefined;
  }[],
  state: {
    occurrences: readonly BudgetOccurrence[];
    reservations?: readonly { budgetId: string; month: string; scheduleIds: readonly string[] }[];
    plans: readonly {
      budgetId: string;
      month: string;
      categoryPlans?: Readonly<Record<string, CategoryPlan>> | undefined;
      incomeForecast: number | null;
      allocations: Readonly<Record<string, number>>;
    }[];
  },
  asOf: string,
  includeCalendar = false,
) {
  const rhythms = new Map<string, Rhythm>();
  const selections = state.reservations
    ?.filter((r) => r.budgetId === budget.id)
    .slice()
    .sort((a, b) => a.month.localeCompare(b.month));
  const reservedIn = (month: string) =>
    selections?.filter((r) => r.month <= month).at(-1)?.scheduleIds ?? budget.reservedScheduleIds;
  const occurrenceMonth = (date: string) => {
    const calendarMonth = date.slice(0, 7);
    if (date >= monthStart(calendarMonth, budget.startDay)) return calendarMonth;
    const previous = new Date(calendarMonth + "-01T00:00:00Z");
    previous.setUTCMonth(previous.getUTCMonth() - 1);
    return previous.toISOString().slice(0, 7);
  };
  const reservedTransactions = new Set(
    state.occurrences
      .filter((o) => {
        const month = occurrenceMonth(o.date);
        return (
          budget.accountIds.includes(o.accountId) &&
          month >= budget.firstMonth &&
          reservedIn(month).includes(o.scheduleId)
        );
      })
      .map((o) => o.transactionId),
  );
  let previousUnassigned = 0;
  let previousRemaining: Record<string, number> = {};
  let result;
  let count = 0;
  for (let month = budget.firstMonth; month <= targetMonth; month = nextMonth(month)) {
    if (++count > 1200) throw new RangeError("Summary exceeds 1200 periods");
    const start = monthStart(month, budget.startDay);
    const end = monthStart(nextMonth(month), budget.startDay);
    const inPeriod = (date: string) => date >= start && date < end;
    const ordinary = history.filter((t) => t.kind === "transaction" && !t.transferId);
    const occurrences = state.occurrences.filter(
      (o) => budget.accountIds.includes(o.accountId) && inPeriod(o.date),
    );
    const reserved = occurrences.filter((o) => reservedIn(month).includes(o.scheduleId));
    const effective = (o: BudgetOccurrence) => {
      const actual = ordinary.find((t) => t.id === o.transactionId);
      return actual?.status === "posted" ? actual.amount : o.amount;
    };
    const commitments = balance(reserved.map((o) => -effective(o)));
    const plan = state.plans.find((p) => p.budgetId === budget.id && p.month === month);
    const expectedIncome =
      plan?.incomeForecast ?? balance(occurrences.filter((o) => o.amount > 0).map((o) => o.amount));
    const spendingUnits = new Map<string, bigint>();
    for (const [id, setting] of Object.entries(plan?.categoryPlans ?? {}))
      if (setting.rhythm) rhythms.set(id, setting.rhythm);
    const dailySpending = new Map<string, Map<string, bigint>>();
    for (const t of ordinary.filter((t) => inPeriod(t.date) && !reservedTransactions.has(t.id))) {
      if (
        t.amount > 0 &&
        (!t.categoryId || state.occurrences.some((o) => o.amount > 0 && o.transactionId === t.id))
      )
        continue;
      const category = t.categoryId ?? "uncategorized";
      const rhythm = rhythms.get(category);
      if (rhythm === "daily" || rhythm === "weekly") {
        const dates = dailySpending.get(category) ?? new Map<string, bigint>();
        dates.set(t.date, (dates.get(t.date) ?? 0n) - BigInt(t.amount));
        dailySpending.set(category, dates);
      }
      spendingUnits.set(category, (spendingUnits.get(category) ?? 0n) - BigInt(t.amount));
    }
    const spending = Object.fromEntries(
      Array.from(spendingUnits, ([category, units]) => [category, balance([Number(units)])]),
    );
    const totals = periodTotals({
      expectedIncome,
      commitments,
      previousUnassigned,
      previousRemaining,
      allocations: plan?.allocations ?? {},
      spending,
    });
    const pacing = new Map<string, ReturnType<typeof paceCategory>["weeks"]>();
    const calendars = new Map<string, NonNullable<ReturnType<typeof paceCategory>["calendar"]>>();
    const weeks = periodWeeks(start, end);
    const opening = Object.fromEntries(
      Object.entries(previousRemaining).map(([id, amount]) => [id, Math.max(0, amount)]),
    );
    for (const [id, rhythm] of rhythms) {
      if (rhythm === "monthly") continue;
      const setting = plan?.categoryPlans?.[id];
      const carried = opening[id] ?? 0;
      const kept = Math.min(carried, setting?.carryIn ?? carried);
      const funding = balance([kept, plan?.allocations[id] ?? 0]);
      const paced = paceCategory(
        weeks,
        funding,
        setting,
        new Map(
          Array.from(dailySpending.get(id) ?? [], ([date, amount]) => [
            date,
            balance([Number(amount)]),
          ]),
        ),
        asOf,
        rhythm === "daily",
        includeCalendar && month === targetMonth,
      );
      const adjustment = balance([paced.adjustment, kept, -carried]);
      totals.unassigned = balance([totals.unassigned, -adjustment]);
      totals.remaining[id] = balance([totals.remaining[id] ?? 0, adjustment]);
      pacing.set(id, paced.weeks);
      if (paced.calendar) calendars.set(id, paced.calendar);
    }
    result = {
      ...(includeCalendar && month === targetMonth
        ? { calendars: Object.fromEntries(calendars) }
        : {}),
      rhythms: Object.fromEntries(rhythms),
      pacing: Object.fromEntries(pacing),
      opening,
      budgetId: budget.id,
      currency: budget.currency,
      month,
      start,
      end,
      expectedIncome,
      commitments,
      spending,
      postedIncome: balance(
        ordinary
          .filter((t) => inPeriod(t.date) && t.status === "posted" && t.amount > 0)
          .map((t) => t.amount),
      ),
      postedNet: balance(
        ordinary.filter((t) => inPeriod(t.date) && t.status === "posted").map((t) => t.amount),
      ),
      ...totals,
    };
    previousUnassigned = totals.unassigned;
    previousRemaining = { ...totals.remaining };
    // Future period previews cannot spend funds still committed to an open week.
    for (const id of pacing.keys()) previousRemaining[id] = Math.min(0, totals.remaining[id] ?? 0);
  }
  return result;
}
