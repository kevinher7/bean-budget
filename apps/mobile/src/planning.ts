import { Schema } from "effect";
import { monthStart, nextMonth, summarizePeriods } from "@bean-budget/budget";
import { Command, Planning, Transaction } from "@bean-budget/protocol";

export const emptyPlanning: typeof Planning.Type = {
  budgets: [],
  schedules: [],
  occurrences: [],
  periods: [],
  reservations: [],
};

export type PlanningCommand = Exclude<
  typeof Command.Type,
  { type: "category" | "payee" | "editTransaction" | "transfer" }
>;

export function projectPlanning(base: typeof Planning.Type, commands: readonly PlanningCommand[]) {
  const state = {
    budgets: [...base.budgets],
    schedules: [...base.schedules],
    occurrences: [...base.occurrences],
    periods: [...base.periods],
    reservations: [...base.reservations],
  };
  for (const command of commands) {
    switch (command.type) {
      case "budget":
        if (!state.budgets.some((row) => row.id === command.value.id)) {
          state.budgets.push({ ...command.value, reservationRevision: 0 });
          state.reservations.push({
            budgetId: command.value.id,
            month: command.value.firstMonth,
            scheduleIds: command.value.reservedScheduleIds,
          });
        }
        break;
      case "schedule": {
        state.schedules = state.schedules.filter((row) => row.id !== command.value.id);
        state.schedules.push({ ...command.value, revision: (command.revision ?? 0) + 1 });
        break;
      }
      case "plan":
        state.periods = state.periods.filter(
          (row) => row.budgetId !== command.value.budgetId || row.month !== command.value.month,
        );
        state.periods.push({ ...command.value, revision: (command.revision ?? 0) + 1 });
        break;
      case "reservation":
        state.reservations = state.reservations.filter(
          (row) => row.budgetId !== command.value.budgetId || row.month !== command.value.month,
        );
        state.reservations.push(command.value);
        state.budgets = state.budgets.map((row) =>
          row.id === command.value.budgetId
            ? { ...row, reservationRevision: command.revision + 1 }
            : row,
        );
        break;
      case "generate": {
        const schedule = state.schedules.find((row) => row.id === command.scheduleId);
        if (!schedule || !command.id) throw new Error("Missing schedule or occurrence identity");
        if (
          !state.occurrences.some(
            (row) => row.scheduleId === command.scheduleId && row.month === command.month,
          )
        )
          state.occurrences.push({
            ...schedule,
            id: command.id,
            scheduleId: schedule.id,
            month: command.month,
            date: monthStart(command.month, schedule.day),
            transactionId: null,
            revision: 0,
          });
        break;
      }
      case "occurrence":
      case "pendingOccurrence":
      case "match": {
        const id = command.type === "occurrence" ? command.id : command.occurrenceId;
        const previous = state.occurrences.find((row) => row.id === id);
        if (!previous) throw new Error("Missing occurrence");
        state.occurrences = state.occurrences.map((row) =>
          row.id !== id
            ? row
            : {
                ...row,
                revision: (command.revision ?? 0) + 1,
                ...(command.type === "occurrence"
                  ? { amount: command.amount }
                  : { transactionId: command.transactionId ?? null }),
              },
        );
        break;
      }
    }
  }
  return Schema.decodeUnknownSync(Planning)(state);
}

export function planningCommands(operations: readonly { kind: string; payload: string }[]) {
  return operations
    .filter((row) => row.kind === "planning")
    .map((row) => {
      const command = Schema.decodeUnknownSync(Schema.fromJsonString(Command), {
        onExcessProperty: "error",
      })(row.payload);
      if (
        command.type === "category" ||
        command.type === "payee" ||
        command.type === "editTransaction" ||
        command.type === "transfer"
      )
        throw new Error("Invalid planning operation");
      return command;
    });
}

export function periodSummary(
  state: typeof Planning.Type,
  budgetId: string,
  month: string,
  transactions: readonly (typeof Transaction.Type)[],
) {
  const budget = state.budgets.find((row) => row.id === budgetId);
  if (!budget || month < budget.firstMonth) throw new Error("Select a period within this budget");
  return summarizePeriods(
    budget,
    month,
    transactions.filter((row) => budget.accountIds.includes(row.accountId)),
    { plans: state.periods, occurrences: state.occurrences, reservations: state.reservations },
  );
}

export function missingOccurrences(state: typeof Planning.Type, budgetId: string, month: string) {
  const budget = state.budgets.find((row) => row.id === budgetId);
  if (!budget) return [];
  const start = monthStart(month, budget.startDay);
  const end = monthStart(nextMonth(month), budget.startDay);
  return state.schedules
    .filter((row) => row.active && budget.accountIds.includes(row.accountId))
    .flatMap((schedule) =>
      [month, nextMonth(month)].flatMap((calendarMonth) => {
        const date = monthStart(calendarMonth, schedule.day);
        return date >= start &&
          date < end &&
          !state.occurrences.some(
            (row) => row.scheduleId === schedule.id && row.month === calendarMonth,
          )
          ? [{ schedule, month: calendarMonth, date }]
          : [];
      }),
    );
}

export function planningKey(command: PlanningCommand) {
  switch (command.type) {
    case "plan":
      return `plan/${command.value.budgetId}/${command.value.month}`;
    case "reservation":
      return `reservation/${command.value.budgetId}`;
    case "budget":
      return `budget/${command.value.id}`;
    case "schedule":
      return `schedule/${command.value.id}`;
    case "generate":
      return `generate/${command.scheduleId}/${command.month}`;
    case "occurrence":
      return `occurrence/${command.id}`;
    case "pendingOccurrence":
    case "match":
      return `occurrence/${command.occurrenceId}`;
  }
}
