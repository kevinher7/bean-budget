import { useEffect, useState } from "react";
import { AppState, View } from "react-native";
import { randomUUID } from "expo-crypto";
import { Schema } from "effect";
import {
  monthStart,
  nextMonth,
  parseMoney,
  tokyoDate,
  periodWeeks,
  type Rhythm,
} from "@bean-budget/budget";
import { Budget, BudgetPeriod, Command, Schedule } from "@bean-budget/protocol";
import { Action, Field, Heading, Label, Selection, TextAction } from "./ui/controls.tsx";
import { spacing } from "./ui/theme.ts";
import {
  missingOccurrences,
  planningCommands,
  periodSummary,
  projectPlanning,
  type PlanningCommand,
} from "./planning.ts";
import { loadLedger } from "./storage.ts";
import type { Effect } from "effect";

type Ledger = Effect.Success<ReturnType<typeof loadLedger>>;
type Save = (build: () => PlanningCommand[], done?: () => void) => void;

function money(amount: number, currency: "JPY" | "USD") {
  return new Intl.NumberFormat(currency === "JPY" ? "ja-JP" : "en-US", {
    style: "currency",
    currency,
  }).format(currency === "USD" ? amount / 100 : amount);
}

function decimal(amount: number, currency: "JPY" | "USD") {
  return currency === "USD" ? (amount / 100).toFixed(2) : String(amount);
}

function previousMonth(month: string) {
  const date = new Date(month + "-01T00:00:00Z");
  date.setUTCMonth(date.getUTCMonth() - 1);
  return date.toISOString().slice(0, 7);
}

function today() {
  return tokyoDate(Date.now());
}

function ToggleList({
  label,
  options,
  value,
  onChange,
  disabled,
}: {
  label: string;
  options: readonly { id: string; name: string }[];
  value: readonly string[];
  onChange: (value: string[]) => void;
  disabled: boolean;
}) {
  return (
    <View style={{ gap: spacing.small }}>
      <Label>{label}</Label>
      {options.map((row) => (
        <TextAction
          key={row.id}
          title={`${value.includes(row.id) ? "✓ " : ""}${row.name}`}
          selected={value.includes(row.id)}
          disabled={disabled}
          onPress={() =>
            onChange(
              value.includes(row.id) ? value.filter((id) => id !== row.id) : [...value, row.id],
            )
          }
        />
      ))}
    </View>
  );
}

export function BudgetScreen({
  ledger,
  busy,
  save,
  recover,
  sync,
  retry,
  createCategory,
}: {
  ledger: Ledger;
  busy: boolean;
  save: Save;
  recover: (id: string, keep: boolean) => void;
  sync: () => void;
  retry: () => void;
  createCategory: (name: string) => void;
}) {
  const [selected, setSelected] = useState(ledger.planning.budgets[0]?.id ?? "");
  const [month, setMonth] = useState("");
  const [mode, setMode] = useState<"period" | "create" | "schedules">("period");
  const budget =
    ledger.planning.budgets.find((row) => row.id === selected) ?? ledger.planning.budgets[0];
  const [financialDate, setFinancialDate] = useState(today);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    function update() {
      clearTimeout(timer);
      const date = today();
      setFinancialDate(date);
      const nextMidnight = Date.parse(date + "T00:00:00+09:00") + 86_400_000;
      timer = setTimeout(update, Math.max(1, nextMidnight - Date.now()));
    }
    update();
    const listener = AppState.addEventListener("change", (state) => {
      if (state === "active") update();
    });
    return () => {
      clearTimeout(timer);
      listener.remove();
    };
  }, []);
  const calendarMonth = financialDate.slice(0, 7);
  const currentMonth =
    budget && financialDate < monthStart(calendarMonth, budget.startDay)
      ? previousMonth(calendarMonth)
      : calendarMonth;
  const target =
    month || (budget && currentMonth < budget.firstMonth ? budget.firstMonth : currentMonth);
  return (
    <View style={{ gap: spacing.medium }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.small }}>
        <TextAction
          title="Periods"
          selected={mode === "period"}
          disabled={busy}
          onPress={() => setMode("period")}
        />
        <TextAction
          title="New budget"
          selected={mode === "create"}
          disabled={busy}
          onPress={() => setMode("create")}
        />
        <TextAction
          title="Recurring payments"
          selected={mode === "schedules"}
          disabled={busy}
          onPress={() => setMode("schedules")}
        />
        <TextAction title="Sync" disabled={busy} onPress={sync} />
        {ledger.failed > 0 && (
          <TextAction title="Retry failed operations" disabled={busy} onPress={retry} />
        )}
      </View>
      {ledger.planningOperations.length > 0 && (
        <Label muted>
          {ledger.planningOperations.length} planning changes waiting. Availability includes local
          edits.
        </Label>
      )}
      {ledger.planningOperations.some((row) => row.error) &&
        ledger.planningOperations.map((row) => {
          const command = planningCommands([row])[0];
          if (!command) return null;
          const title =
            command.type === "plan"
              ? `Period plan · ${command.value.month}`
              : command.type === "reservation"
                ? `Reserved bills · from ${command.value.month}`
                : command.type === "schedule"
                  ? scheduleLabel(command.value, ledger)
                  : command.type === "budget"
                    ? command.value.name
                    : command.type === "generate"
                      ? `Generate estimate · ${command.month}`
                      : command.type === "match"
                        ? "Match full payment"
                        : command.type === "pendingOccurrence"
                          ? "Create pending payment"
                          : "Change payment estimate";
          const replacement =
            command.type === "plan" ||
            command.type === "reservation" ||
            command.type === "schedule" ||
            command.type === "occurrence";
          return (
            <View key={row.operationId} style={{ gap: spacing.small }}>
              <Label>{title}</Label>
              <Label>{row.error ?? "Waiting change"}</Label>
              <Label muted>
                Sync first to refresh accepted values. Recovery applies to related queued edits.
                Discarding a planned payment also discards its unsynchronized posting and metadata
                edits. Payments already accepted by the server remain.
              </Label>
              {replacement && (
                <Action
                  title="Keep local replacements"
                  secondary
                  disabled={busy}
                  onPress={() => recover(row.operationId, true)}
                />
              )}
              <Action
                title="Use server / discard related changes"
                secondary
                disabled={busy}
                onPress={() => recover(row.operationId, false)}
              />
            </View>
          );
        })}
      {mode === "create" && (
        <BudgetSetup
          ledger={ledger}
          busy={busy}
          save={save}
          done={(id) => {
            setSelected(id);
            setMonth("");
            setMode("period");
          }}
        />
      )}
      {mode === "schedules" && <Schedules ledger={ledger} busy={busy} save={save} />}
      {mode === "period" && (
        <>
          <Selection
            label="Budget"
            emptyLabel="Choose a budget"
            value={budget?.id ?? ""}
            options={ledger.planning.budgets}
            disabled={busy}
            onChange={(id) => {
              setSelected(id);
              setMonth("");
            }}
          />
          {!budget ? (
            <Label>
              Create recurring payments, then create a budget. You can change reserved bills later.
            </Label>
          ) : (
            <>
              <Label muted>
                {budget.currency}. Accounts and period boundaries are fixed. Opening carryover is
                zero in the first period.
              </Label>
              <View style={{ flexDirection: "row", gap: spacing.small }}>
                <TextAction
                  title="Previous"
                  disabled={busy || target <= budget.firstMonth}
                  onPress={() => setMonth(previousMonth(target))}
                />
                <Label>{target}</Label>
                <TextAction
                  title="Next"
                  disabled={busy || target >= "9999-11"}
                  onPress={() => setMonth(nextMonth(target))}
                />
              </View>
              <Period
                key={budget.id + "/" + target}
                ledger={ledger}
                budget={budget}
                month={target}
                busy={busy}
                save={save}
                createCategory={createCategory}
              />
            </>
          )}
        </>
      )}
    </View>
  );
}

function BudgetSetup({
  ledger,
  busy,
  save,
  done,
}: {
  ledger: Ledger;
  busy: boolean;
  save: Save;
  done: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [currency, setCurrency] = useState<"JPY" | "USD">("JPY");
  const [accountIds, setAccounts] = useState<string[]>([]);
  const [reserved, setReserved] = useState<string[]>([]);
  const [startDay, setDay] = useState("1");
  const [firstMonth, setFirstMonth] = useState(today().slice(0, 7));
  return (
    <View style={{ gap: spacing.small }}>
      <Heading>New tracking budget</Heading>
      <Field label="Name" value={name} onChangeText={setName} editable={!busy} />
      <Selection
        label="Currency"
        value={currency}
        options={[
          { id: "JPY", name: "JPY" },
          { id: "USD", name: "USD" },
        ]}
        disabled={busy}
        onChange={(value) => {
          setCurrency(value === "USD" ? "USD" : "JPY");
          setAccounts([]);
          setReserved([]);
        }}
      />
      <ToggleList
        label="Included accounts"
        options={ledger.accounts.filter((row) => row.currency === currency)}
        value={accountIds}
        disabled={busy}
        onChange={(ids) => {
          setAccounts(ids);
          setReserved(
            reserved.filter((id) =>
              ledger.planning.schedules.some((row) => row.id === id && ids.includes(row.accountId)),
            ),
          );
        }}
      />
      <Field
        label="Monthly start day, 1 to 31"
        value={startDay}
        onChangeText={setDay}
        keyboardType="number-pad"
        editable={!busy}
      />
      <Field
        label="First period, YYYY-MM"
        value={firstMonth}
        onChangeText={setFirstMonth}
        editable={!busy}
      />
      <ToggleList
        label="Reserved bills"
        options={ledger.planning.schedules
          .filter((row) => row.amount < 0 && accountIds.includes(row.accountId))
          .map((row) => ({ id: row.id, name: scheduleLabel(row, ledger) }))}
        value={reserved}
        onChange={setReserved}
        disabled={busy}
      />
      <Label muted>
        This tracks expected income. Account balances do not set your spending allowance.
      </Label>
      <Action
        title="Create budget"
        disabled={busy || !accountIds.length}
        onPress={() => {
          const id = randomUUID();
          save(
            () => [
              {
                type: "budget",
                operationId: randomUUID(),
                value: Schema.decodeUnknownSync(Budget)({
                  id,
                  name: name.trim(),
                  currency,
                  accountIds,
                  startDay: Number(startDay),
                  firstMonth,
                  reservedScheduleIds: reserved,
                }),
              },
            ],
            () => done(id),
          );
        }}
      />
    </View>
  );
}

function scheduleLabel(schedule: typeof Schedule.Type, ledger: Ledger) {
  const account = ledger.accounts.find((row) => row.id === schedule.accountId);
  return `${ledger.categories.find((row) => row.id === schedule.categoryId)?.name ?? (schedule.amount > 0 ? "Income" : "Bill")} · ${account?.name ?? "Account"} · ${money(schedule.amount, account?.currency ?? "JPY")} · day ${schedule.day}${schedule.active ? "" : " · inactive"}`;
}

function Schedules({ ledger, busy, save }: { ledger: Ledger; busy: boolean; save: Save }) {
  const [editing, setEditing] = useState<string>();
  const schedule = ledger.planning.schedules.find((row) => row.id === editing);
  return (
    <View style={{ gap: spacing.small }}>
      <Heading>Recurring payments</Heading>
      <Label muted>
        Templates generate estimates only when requested. Editing a template leaves existing
        occurrences unchanged.
      </Label>
      {ledger.planning.schedules.map((row) => (
        <TextAction
          key={row.id}
          title={scheduleLabel(row, ledger)}
          disabled={busy}
          onPress={() => setEditing(row.id)}
        />
      ))}
      <Action
        title="New recurring payment"
        secondary
        disabled={busy || !ledger.accounts.length}
        onPress={() => setEditing("new")}
      />
      {editing && (
        <ScheduleEditor
          key={editing}
          schedule={schedule}
          ledger={ledger}
          busy={busy}
          save={save}
          done={() => setEditing(undefined)}
        />
      )}
    </View>
  );
}

function ScheduleEditor({
  schedule,
  ledger,
  busy,
  save,
  done,
}: {
  schedule: typeof Schedule.Type | undefined;
  ledger: Ledger;
  busy: boolean;
  save: Save;
  done: () => void;
}) {
  const [accountId, setAccount] = useState(schedule?.accountId ?? ledger.accounts[0]?.id ?? "");
  const account = ledger.accounts.find((row) => row.id === accountId);
  const [income, setIncome] = useState((schedule?.amount ?? -1) > 0);
  const [amount, setAmount] = useState(
    schedule && account ? decimal(Math.abs(schedule.amount), account.currency) : "",
  );
  const [day, setDay] = useState(String(schedule?.day ?? 1));
  const [category, setCategory] = useState(schedule?.categoryId ?? "");
  const [payee, setPayee] = useState(schedule?.payeeId ?? "");
  const [active, setActive] = useState(schedule?.active ?? true);
  const [revision] = useState(schedule?.revision ?? 0);
  return (
    <View style={{ gap: spacing.small }}>
      <Selection
        label="Account"
        value={accountId}
        options={ledger.accounts}
        onChange={setAccount}
        disabled={busy || !!schedule}
      />
      <Action
        title={income ? "Income" : "Expense"}
        secondary
        onPress={() => setIncome(!income)}
        disabled={busy || !!schedule}
      />
      <Field
        label={`Amount, ${account?.currency ?? ""}`}
        value={amount}
        onChangeText={setAmount}
        keyboardType="decimal-pad"
        editable={!busy}
      />
      <Field
        label="Day, 1 to 31"
        value={day}
        onChangeText={setDay}
        keyboardType="number-pad"
        editable={!busy}
      />
      <Selection
        label="Category"
        emptyLabel="Uncategorized"
        value={category}
        options={ledger.categories}
        onChange={setCategory}
        disabled={busy}
      />
      <Selection
        label="Payee"
        emptyLabel="None"
        value={payee}
        options={ledger.payees}
        onChange={setPayee}
        disabled={busy}
      />
      <Action
        title={active ? "Active" : "Inactive"}
        secondary
        onPress={() => setActive(!active)}
        disabled={busy}
      />
      <Action
        title="Save recurring payment"
        disabled={busy || !account}
        onPress={() =>
          save(() => {
            if (!account) throw new Error("Choose an account");
            const units = parseMoney(amount, account.currency);
            if (units <= 0) throw new Error("Enter a positive amount");
            return [
              {
                type: "schedule",
                operationId: randomUUID(),
                revision,
                value: Schema.decodeUnknownSync(Schedule)({
                  id: schedule?.id ?? randomUUID(),
                  accountId,
                  amount: income ? units : -units,
                  day: Number(day),
                  categoryId: category || null,
                  payeeId: payee || null,
                  active,
                }),
              },
            ];
          }, done)
        }
      />
      <TextAction title="Cancel" disabled={busy} onPress={done} />
    </View>
  );
}

function Period({
  ledger,
  budget,
  month,
  busy,
  save,
  createCategory,
}: {
  ledger: Ledger;
  budget: typeof Budget.Type;
  month: string;
  busy: boolean;
  save: Save;
  createCategory: (name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [pacingMonth, setPacingMonth] = useState("");
  const [reserveEditing, setReserveEditing] = useState(false);
  let summary: ReturnType<typeof periodSummary>;
  let missing: ReturnType<typeof missingOccurrences> = [];
  let unavailable = "";
  let start = "";
  let end = "";
  try {
    start = monthStart(month, budget.startDay);
    end = monthStart(nextMonth(month), budget.startDay);
    if (
      ledger.planningConflict ||
      ledger.deferredTransactions.some((row) => budget.accountIds.includes(row.accountId))
    )
      throw new Error("Receipt reconciliation incomplete");
    summary = periodSummary(ledger.planning, budget.id, month, ledger.transactions);
    let cursor = budget.firstMonth;
    for (let count = 0; cursor <= month && count < 1200; count++, cursor = nextMonth(cursor))
      missing.push(...missingOccurrences(ledger.planning, budget.id, cursor));
  } catch {
    unavailable =
      "Availability unavailable. Resolve planning conflicts or finish synchronization, and check the supported period range and amounts.";
  }
  const occurrences = ledger.planning.occurrences.filter(
    (row) => budget.accountIds.includes(row.accountId) && row.date >= start && row.date < end,
  );
  return (
    <View style={{ gap: spacing.medium }}>
      <Label>
        {start} to {end}, end excluded
      </Label>
      {unavailable ? (
        <Label>{unavailable}</Label>
      ) : (
        summary && (
          <>
            <Label>
              Expected income {money(summary.expectedIncome, budget.currency)} · posted income{" "}
              {money(summary.postedIncome, budget.currency)}
            </Label>
            <Label>Reserved commitments {money(summary.commitments, budget.currency)}</Label>
            <Label>
              Assignable {money(summary.assignable, budget.currency)} · unbudgeted{" "}
              {money(summary.unassigned, budget.currency)}
            </Label>
            <Label muted>
              Previous overspending deduction {money(summary.overspending, budget.currency)}
            </Label>
            {Object.entries(summary.remaining).map(([id, remaining]) => (
              <View key={id} style={{ gap: spacing.small }}>
                <Label>
                  {ledger.categories.find((row) => row.id === id)?.name ?? "Uncategorized"} ·
                  remaining {money(remaining, budget.currency)}
                </Label>
                <Label muted>
                  Monthly allocation{" "}
                  {money(
                    ledger.planning.periods.find(
                      (row) => row.budgetId === budget.id && row.month === month,
                    )?.allocations[id] ?? 0,
                    budget.currency,
                  )}{" "}
                  · net spending {money(summary?.spending[id] ?? 0, budget.currency)}
                </Label>
                {summary?.pacing[id]?.map((week) => (
                  <View key={week.start}>
                    <Label muted>
                      {week.start} · {money(week.limit, budget.currency)}{" "}
                      {week.fixed ? "fixed" : "flexible"} · spent{" "}
                      {money(week.spent, budget.currency)}
                    </Label>
                    {week.leftToday !== null && (
                      <Label>Left today {money(week.leftToday, budget.currency)}</Label>
                    )}
                  </View>
                ))}
              </View>
            ))}
          </>
        )
      )}
      <Label muted>
        Income forecasts are estimates. Categorized positive entries reduce spending as refunds.
        Carryover includes prior plans and ledger edits.
      </Label>
      {missing.length > 0 && (
        <View style={{ gap: spacing.small }}>
          <Label>
            {missing.length} missing recurring estimates through this period. Totals currently
            include generated occurrences only.
          </Label>
          {missing.map((row) => (
            <Label key={row.schedule.id + row.month} muted>
              {row.date} · {scheduleLabel(row.schedule, ledger)}
            </Label>
          ))}
          <Action
            title="Generate these estimates"
            disabled={busy}
            onPress={() =>
              save(() =>
                missing.map((row) => ({
                  type: "generate",
                  operationId: randomUUID(),
                  scheduleId: row.schedule.id,
                  month: row.month,
                  revision: row.schedule.revision ?? 0,
                  id: randomUUID(),
                })),
              )
            }
          />
        </View>
      )}
      <Action
        title="Edit forecast and allocations"
        secondary
        disabled={busy}
        onPress={() => setEditing(!editing)}
      />
      {editing && (
        <PlanEditor
          ledger={ledger}
          budget={budget}
          month={month}
          busy={busy}
          save={save}
          done={() => setEditing(false)}
          createCategory={createCategory}
        />
      )}
      <Action
        title="Plan category rhythms"
        secondary
        disabled={busy || !summary}
        onPress={() => setPacingMonth(pacingMonth ? "" : nextMonth(month))}
      />
      {pacingMonth !== "" && (
        <>
          <Selection
            label="Effective period"
            value={pacingMonth}
            disabled={busy}
            options={[month, nextMonth(month)].map((id) => ({ id, name: id }))}
            onChange={(id) => {
              if (id) setPacingMonth(id);
            }}
          />
          <CategoryPlanning
            key={pacingMonth}
            month={pacingMonth}
            ledger={ledger}
            budget={budget}
            busy={busy}
            save={save}
            done={() => setPacingMonth("")}
          />
        </>
      )}
      <Action
        title="Change reserved bills from this period"
        secondary
        disabled={busy}
        onPress={() => setReserveEditing(!reserveEditing)}
      />
      {reserveEditing && (
        <ReservationEditor
          ledger={ledger}
          budget={budget}
          month={month}
          busy={busy}
          save={save}
          done={() => setReserveEditing(false)}
        />
      )}
      <Heading>Expected payments</Heading>
      {occurrences.length === 0 && <Label muted>No generated payments in this period.</Label>}
      {occurrences.map((row) => (
        <OccurrenceEditor
          key={row.id + "/" + row.revision}
          occurrenceId={row.id}
          ledger={ledger}
          busy={busy}
          save={save}
        />
      ))}
    </View>
  );
}

type CategoryPlanningProps = {
  ledger: Ledger;
  budget: typeof Budget.Type;
  month: string;
  busy: boolean;
  save: Save;
  done: () => void;
};

function CategoryPlanning(props: CategoryPlanningProps) {
  const [category, setCategory] = useState("");
  let summary: ReturnType<typeof periodSummary>;
  try {
    summary = periodSummary(
      props.ledger.planning,
      props.budget.id,
      props.month,
      props.ledger.transactions,
    );
  } catch {
    return (
      <Label>
        Category planning is unavailable for this period. Check the supported date range and
        amounts.
      </Label>
    );
  }
  return (
    <View style={{ gap: spacing.small }}>
      <Selection
        label="Planning category"
        value={category}
        disabled={props.busy}
        options={props.ledger.categories}
        onChange={setCategory}
      />
      {summary && category !== "" && (
        <CategoryPacingEditor key={category} {...props} category={category} summary={summary} />
      )}
    </View>
  );
}

function CategoryPacingEditor({
  ledger,
  budget,
  month,
  category,
  summary,
  busy,
  save,
  done,
}: CategoryPlanningProps & {
  category: string;
  summary: NonNullable<ReturnType<typeof periodSummary>>;
}) {
  const [plan] = useState(() =>
    ledger.planning.periods.find((row) => row.budgetId === budget.id && row.month === month),
  );
  const initial = plan?.categoryPlans?.[category];
  const inherited = summary.rhythms[category] ?? "monthly";
  const [rhythm, setRhythm] = useState<Rhythm>(initial?.rhythm ?? inherited);
  const opening = summary.opening[category] ?? 0;
  const [carry, setCarry] = useState(
    initial?.carryIn === undefined ? "" : decimal(initial.carryIn, budget.currency),
  );
  const [limits, setLimits] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      Object.entries(initial?.limits ?? {}).map(([start, edit]) => [
        start,
        decimal(edit.amount, budget.currency),
      ]),
    ),
  );
  const [preview, setPreview] = useState<{ command: PlanningCommand; lines: string[] }>();
  const [error, setError] = useState("");
  const start = monthStart(month, budget.startDay);
  const weeks = periodWeeks(start, monthStart(nextMonth(month), budget.startDay));
  const allocatingCarry = rhythm !== "monthly" && opening > 0;
  function previewPlan() {
    setError("");
    setPreview(undefined);
    try {
      if (
        ledger.planningConflict ||
        ledger.deferredTransactions.some((row) => budget.accountIds.includes(row.accountId))
      )
        throw new Error("Finish synchronization before editing this plan");
      const date = today();
      const categoryPlans = { ...plan?.categoryPlans };
      const fixedLimits: Record<string, { amount: number; fixedFrom: string }> = {};
      if (rhythm !== "monthly")
        for (const week of weeks) {
          const value = limits[week.start]?.trim();
          if (value)
            fixedLimits[week.start] = {
              amount: parseMoney(value, budget.currency),
              fixedFrom:
                initial?.limits?.[week.start]?.fixedFrom ?? (date >= week.end ? week.start : date),
            };
        }
      const setting: NonNullable<typeof BudgetPeriod.Type.categoryPlans>[string] = {
        ...(initial?.rhythm !== undefined || rhythm !== inherited ? { rhythm } : {}),
        ...(allocatingCarry
          ? { rhythm, carryIn: parseMoney(carry.trim(), budget.currency) }
          : rhythm !== "monthly" && (inherited === "monthly" || initial?.carryIn !== undefined)
            ? { rhythm, carryIn: initial?.carryIn ?? 0 }
            : {}),
        ...(Object.keys(fixedLimits).length ? { limits: fixedLimits } : {}),
      };
      if (allocatingCarry && (setting.carryIn ?? 0) > opening)
        throw new Error("Carry into weeks cannot exceed the opening balance");
      if (Object.keys(setting).length) categoryPlans[category] = setting;
      else delete categoryPlans[category];
      const command: PlanningCommand = {
        type: "plan",
        operationId: randomUUID(),
        revision: plan?.revision ?? 0,
        value: Schema.decodeUnknownSync(BudgetPeriod)({
          budgetId: budget.id,
          month,
          incomeForecast: plan?.incomeForecast ?? null,
          allocations: plan?.allocations ?? {},
          categoryPlans,
        }),
      };
      const projected = projectPlanning(ledger.planning, [command]);
      const after = periodSummary(projected, budget.id, month, ledger.transactions);
      if (!after) throw new Error("Period unavailable");
      const lines = [
        `${month} unbudgeted ${money(summary.unassigned, budget.currency)} → ${money(after.unassigned, budget.currency)}`,
      ];
      for (const week of after.pacing[category] ?? [])
        lines.push(
          `${week.start} · ${money(week.limit, budget.currency)} ${week.fixed ? "fixed" : "flexible"}`,
        );
      const current =
        date < monthStart(date.slice(0, 7), budget.startDay)
          ? previousMonth(date.slice(0, 7))
          : date.slice(0, 7);
      if (month < current) {
        const beforeCurrent = periodSummary(
          ledger.planning,
          budget.id,
          current,
          ledger.transactions,
        );
        const afterCurrent = periodSummary(projected, budget.id, current, ledger.transactions);
        if (beforeCurrent && afterCurrent)
          lines.push(
            `${current} unbudgeted ${money(beforeCurrent.unassigned, budget.currency)} → ${money(afterCurrent.unassigned, budget.currency)}`,
          );
      }
      setPreview({ command, lines });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Invalid category plan");
    }
  }
  return (
    <View style={{ gap: spacing.small }}>
      <Selection
        label="Category rhythm"
        disabled={busy}
        value={rhythm}
        options={[
          { id: "monthly", name: "Monthly" },
          { id: "weekly", name: "Weekly" },
          { id: "daily", name: "Daily" },
        ]}
        onChange={(id) => {
          if (id === "monthly" || id === "weekly" || id === "daily") {
            setRhythm(id);
            setPreview(undefined);
          }
        }}
      />
      {allocatingCarry && (
        <>
          <Label>
            Opening balance {money(opening, budget.currency)}. The rest returns to unbudgeted.
          </Label>
          <Field
            label="Carry into weeks"
            value={carry}
            onChangeText={(value) => {
              setCarry(value);
              setPreview(undefined);
            }}
            editable={!busy}
            keyboardType="decimal-pad"
          />
        </>
      )}
      {rhythm !== "monthly" && (
        <>
          <Label muted>
            Blank weeks use the monthly allocation. Enter an amount to fix a week.
          </Label>
          {weeks.map((week) => (
            <Field
              key={week.start}
              label={`Week starting ${week.start}`}
              value={limits[week.start] ?? ""}
              onChangeText={(value) => {
                setLimits({ ...limits, [week.start]: value });
                setPreview(undefined);
              }}
              editable={!busy}
              keyboardType="decimal-pad"
            />
          ))}
        </>
      )}
      <Action title="Preview category plan" disabled={busy} onPress={previewPlan} />
      {error !== "" && <Label>{error}</Label>}
      {preview && (
        <>
          {preview.lines.map((line) => (
            <Label key={line}>{line}</Label>
          ))}
          <Action
            title="Save category plan"
            disabled={busy}
            onPress={() => save(() => [preview.command], done)}
          />
        </>
      )}
    </View>
  );
}

function PlanEditor({
  ledger,
  budget,
  month,
  busy,
  save,
  createCategory,
  done,
}: {
  ledger: Ledger;
  budget: typeof Budget.Type;
  month: string;
  busy: boolean;
  save: Save;
  createCategory: (name: string) => void;
  done: () => void;
}) {
  const plan = ledger.planning.periods.find(
    (row) => row.budgetId === budget.id && row.month === month,
  );
  const [forecast, setForecast] = useState(
    plan?.incomeForecast == null ? "" : decimal(plan.incomeForecast, budget.currency),
  );
  const [allocations, setAllocations] = useState<Record<string, string>>(
    Object.fromEntries(
      Object.entries(plan?.allocations ?? {}).map(([id, amount]) => [
        id,
        decimal(amount, budget.currency),
      ]),
    ),
  );
  const [revision] = useState(plan?.revision ?? 0);
  const [categoryName, setCategoryName] = useState("");
  return (
    <View style={{ gap: spacing.small }}>
      <Field
        label="Income forecast, blank uses generated income estimates"
        value={forecast}
        onChangeText={setForecast}
        keyboardType="decimal-pad"
        editable={!busy}
      />
      {ledger.categories.map((row) => (
        <Field
          key={row.id}
          label={row.name}
          value={allocations[row.id] ?? ""}
          onChangeText={(value) => setAllocations({ ...allocations, [row.id]: value })}
          keyboardType="decimal-pad"
          editable={!busy}
        />
      ))}
      <Field
        label="New category"
        value={categoryName}
        onChangeText={setCategoryName}
        editable={!busy}
      />
      <TextAction
        title="Add category"
        disabled={busy || !categoryName.trim()}
        onPress={() => createCategory(categoryName)}
      />
      <Action
        title="Save period plan"
        disabled={busy}
        onPress={() =>
          save(
            () => [
              {
                type: "plan",
                operationId: randomUUID(),
                revision,
                value: {
                  budgetId: budget.id,
                  month,
                  incomeForecast:
                    forecast.trim() === "" ? null : parseMoney(forecast, budget.currency),
                  allocations: Object.fromEntries(
                    Object.entries(allocations)
                      .filter(([, value]) => value.trim() !== "")
                      .map(([id, value]) => [id, parseMoney(value, budget.currency)]),
                  ),
                },
              },
            ],
            done,
          )
        }
      />
    </View>
  );
}

function ReservationEditor({
  ledger,
  budget,
  month,
  busy,
  save,
  done,
}: {
  ledger: Ledger;
  budget: typeof Budget.Type;
  month: string;
  busy: boolean;
  save: Save;
  done: () => void;
}) {
  const selections = ledger.planning.reservations
    .filter((row) => row.budgetId === budget.id)
    .slice()
    .sort((a, b) => a.month.localeCompare(b.month));
  const [selected, setSelected] = useState<readonly string[]>(
    selections.filter((row) => row.month <= month).at(-1)?.scheduleIds ?? [],
  );
  const [revision] = useState(budget.reservationRevision ?? 0);
  const [preview, setPreview] = useState<PlanningCommand>();
  const [error, setError] = useState("");
  const next = selections.find((row) => row.month > month)?.month;
  let comparisons: string[] = [];
  if (preview) {
    try {
      if (
        ledger.planningConflict ||
        ledger.deferredTransactions.some((row) => budget.accountIds.includes(row.accountId))
      )
        throw new Error("Finish receipt reconciliation");
      const projected = projectPlanning(ledger.planning, [preview]);
      const through =
        [
          today().slice(0, 7),
          month,
          ...ledger.planning.periods
            .filter((row) => row.budgetId === budget.id)
            .map((row) => row.month),
          ...ledger.transactions
            .filter((row) => budget.accountIds.includes(row.accountId))
            .map((row) => row.date.slice(0, 7)),
        ]
          .sort()
          .at(-1) ?? month;
      for (
        let cursor = month, count = 0;
        cursor <= through && count < 1200;
        cursor = nextMonth(cursor), count++
      ) {
        const before = periodSummary(ledger.planning, budget.id, cursor, ledger.transactions);
        const after = periodSummary(projected, budget.id, cursor, ledger.transactions);
        if (before && after) {
          comparisons.push(
            `${cursor} · unassigned ${money(before.unassigned, budget.currency)} → ${money(after.unassigned, budget.currency)}`,
          );
          for (const id of new Set([
            ...Object.keys(before.remaining),
            ...Object.keys(after.remaining),
          ])) {
            const previous = before.remaining[id] ?? 0;
            const remaining = after.remaining[id] ?? 0;
            if (previous !== remaining)
              comparisons.push(
                `${cursor} · ${ledger.categories.find((row) => row.id === id)?.name ?? "Uncategorized"} · remaining ${money(previous, budget.currency)} → ${money(remaining, budget.currency)}`,
              );
          }
        }
      }
    } catch {
      comparisons = ["Preview unavailable. Check supported amounts and period range."];
    }
  }
  return (
    <View style={{ gap: spacing.small }}>
      <ToggleList
        label="Reserved bills"
        options={ledger.planning.schedules
          .filter((row) => row.amount < 0 && budget.accountIds.includes(row.accountId))
          .map((row) => ({ id: row.id, name: scheduleLabel(row, ledger) }))}
        value={selected}
        disabled={busy}
        onChange={(value) => {
          setSelected(value);
          setPreview(undefined);
        }}
      />
      <Label muted>
        Applies from {month}
        {next ? ` until ${next}` : " onward"}. Historical changes recalculate carryover. Generated
        estimates may still be incomplete.
      </Label>
      {error && <Label>{error}</Label>}
      <Action
        title="Preview change"
        secondary
        disabled={busy}
        onPress={() => {
          try {
            const command = Schema.decodeUnknownSync(Command)({
              type: "reservation",
              operationId: randomUUID(),
              revision,
              value: { budgetId: budget.id, month, scheduleIds: selected },
            });
            if (command.type === "reservation") {
              setPreview(command);
              setError("");
            }
          } catch {
            setError("Invalid reservation selection");
          }
        }}
      />
      {comparisons.map((line) => (
        <Label key={line}>{line}</Label>
      ))}
      {preview &&
        comparisons[0] !== "Preview unavailable. Check supported amounts and period range." && (
          <Action
            title="Confirm reservation change and recalculate"
            disabled={busy}
            onPress={() => save(() => [preview], done)}
          />
        )}
    </View>
  );
}

function OccurrenceEditor({
  occurrenceId,
  ledger,
  busy,
  save,
}: {
  occurrenceId: string;
  ledger: Ledger;
  busy: boolean;
  save: Save;
}) {
  const occurrence = ledger.planning.occurrences.find((row) => row.id === occurrenceId);
  const account = ledger.accounts.find((row) => row.id === occurrence?.accountId);
  const [amount, setAmount] = useState(
    occurrence && account ? decimal(Math.abs(occurrence.amount), account.currency) : "",
  );
  const [match, setMatch] = useState("");
  if (!occurrence || !account) return null;
  const transaction = ledger.transactions.find((row) => row.id === occurrence.transactionId);
  const candidates = ledger.transactions.filter(
    (row) =>
      row.kind === "transaction" &&
      !row.transferId &&
      row.accountId === occurrence.accountId &&
      Math.sign(row.amount) === Math.sign(occurrence.amount) &&
      !ledger.planning.occurrences.some((o) => o.transactionId === row.id),
  );
  return (
    <View style={{ gap: spacing.small }}>
      <Label>
        {occurrence.date} ·{" "}
        {ledger.categories.find((row) => row.id === occurrence.categoryId)?.name ??
          (occurrence.amount > 0 ? "Income" : "Bill")}{" "}
        · {money(occurrence.amount, account.currency)}
      </Label>
      {transaction ? (
        <Label muted>
          Linked {transaction.status ?? "posted"} payment ·{" "}
          {money(transaction.amount, account.currency)} on {transaction.date}. Post pending payments
          in the register.
        </Label>
      ) : (
        <>
          <Field
            label="Estimated amount"
            value={amount}
            onChangeText={setAmount}
            keyboardType="decimal-pad"
            editable={!busy}
          />
          <Action
            title="Save estimate"
            secondary
            disabled={busy}
            onPress={() =>
              save(() => {
                const units = parseMoney(amount, account.currency);
                if (units <= 0) throw new Error("Enter a positive estimate");
                return [
                  {
                    type: "occurrence",
                    operationId: randomUUID(),
                    id: occurrence.id,
                    amount: occurrence.amount > 0 ? units : -units,
                    revision: occurrence.revision ?? 0,
                  },
                ];
              })
            }
          />
          <Action
            title="Create pending payment"
            secondary
            disabled={busy}
            onPress={() =>
              save(() => [
                {
                  type: "pendingOccurrence",
                  operationId: randomUUID(),
                  occurrenceId: occurrence.id,
                  transactionId: randomUUID(),
                  revision: occurrence.revision ?? 0,
                },
              ])
            }
          />
          <Selection
            label="Existing payment, full settlement"
            emptyLabel="Choose payment"
            value={match}
            options={candidates.map((row) => ({
              id: row.id,
              name: `${row.date} · ${money(row.amount, account.currency)} · ${row.notes ?? ledger.payees.find((payee) => payee.id === row.payeeId)?.name ?? row.id.slice(0, 8)}`,
            }))}
            onChange={setMatch}
            disabled={busy}
          />
          <Action
            title="Match as full payment"
            secondary
            disabled={busy || !match}
            onPress={() =>
              save(() => [
                {
                  type: "match",
                  operationId: randomUUID(),
                  occurrenceId: occurrence.id,
                  transactionId: match,
                  revision: occurrence.revision ?? 0,
                },
              ])
            }
          />
        </>
      )}
    </View>
  );
}
