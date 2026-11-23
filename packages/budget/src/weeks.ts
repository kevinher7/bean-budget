import { Schema } from "effect";

export type Rhythm = typeof PlanningRhythm.Type;

export interface CategoryPlan {
  rhythm?: Rhythm | undefined;
  carryIn?: number | undefined;
  limits?: Readonly<Record<string, { amount: number; fixedFrom: string }>> | undefined;
}

export const PlanningRhythm = Schema.Literals(["monthly", "weekly", "daily"]);

const dayMs = 86_400_000;

const tokyo = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function tokyoDate(milliseconds: number) {
  return tokyo.format(milliseconds);
}

export function periodWeeks(start: string, end: string) {
  const weeks = [];
  const until = Date.parse(end);
  for (let time = Date.parse(start); time < until;) {
    const days = Math.min(7 - ((new Date(time).getUTCDay() + 6) % 7), (until - time) / dayMs);
    const next = time + days * dayMs;
    weeks.push({
      start: new Date(time).toISOString().slice(0, 10),
      end: new Date(next).toISOString().slice(0, 10),
      days,
    });
    time = next;
  }
  return weeks;
}

function shares(amount: number, weights: readonly number[]) {
  const total = weights.reduce((sum, item) => sum + item, 0);
  const values = weights.map((weight) => Math.floor((amount * weight) / total));
  const extra = amount - values.reduce((sum, item) => sum + item, 0);
  return values.map((value, index) => value + Number(index < extra));
}

export function paceCategory(
  weeks: ReturnType<typeof periodWeeks>,
  funding: number,
  plan: CategoryPlan | undefined,
  spending: ReadonlyMap<string, number>,
  asOf: string,
  daily: boolean,
) {
  const baseline = shares(
    funding,
    weeks.map((week) => week.days),
  );
  const rows = weeks.map((week, index) => ({
    ...week,
    limit: baseline[index] ?? 0,
    fixed: false,
    spent: 0,
    leftToday: null as number | null,
  }));
  let adjustment = 0;
  // A limit fixed after a week closed must keep its share of that earlier overrun.
  // Replay the closing first, then apply the later edit against the reduced limit.
  function activate(through: string) {
    for (const row of rows) {
      const edit = plan?.limits?.[row.start];
      if (!edit || row.fixed || edit.fixedFrom >= through) continue;
      adjustment += edit.amount - row.limit;
      row.limit = edit.amount;
      row.fixed = true;
    }
  }
  for (const week of rows) {
    activate(week.end);
    for (const [date, amount] of spending) {
      if (date < week.start || date >= week.end) continue;
      week.spent += amount;
    }
    if (asOf < week.end) continue;
    let excess = week.spent - week.limit;
    if (excess <= 0) {
      adjustment += excess;
      continue;
    }
    while (excess > 0) {
      const flexible = rows.filter((row) => row.start >= week.end && !row.fixed && row.limit > 0);
      if (!flexible.length) break;
      const deductions = shares(
        excess,
        flexible.map((row) => row.days),
      );
      for (const [index, row] of flexible.entries()) {
        const deduction = Math.min(row.limit, deductions[index] ?? 0);
        row.limit -= deduction;
        excess -= deduction;
      }
    }
    adjustment += excess;
  }
  if (daily) {
    const week = rows.find((row) => row.start <= asOf && asOf < row.end);
    if (week) {
      const daysLeft = (Date.parse(week.end) - Date.parse(asOf)) / dayMs;
      let previous = 0;
      for (const [date, amount] of spending)
        if (date >= week.start && date < asOf) previous += amount;
      week.leftToday =
        Math.ceil(Math.max(0, week.limit - previous) / daysLeft) - (spending.get(asOf) ?? 0);
    }
  }
  return { weeks: rows, adjustment };
}
