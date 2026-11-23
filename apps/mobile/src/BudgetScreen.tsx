import { useEffect, useState, type RefObject } from "react";
import { AppState, Pressable, Text, View } from "react-native";
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
  BudgetButton,
  BudgetRow,
  BudgetSheet,
  dateRange,
  monthName,
  styles,
} from "./ui/budget.tsx";
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
  widgetBudget,
  draftGuard,
  ledger,
  busy,
  save,
  recover,
  sync,
  retry,
  createCategory,
  error,
}: {
  draftGuard: RefObject<boolean>;
  widgetBudget?: { budget: string; category: string } | undefined;
  ledger: Ledger;
  error: string;
  busy: boolean;
  save: Save;
  recover: (id: string, keep: boolean) => void;
  sync: () => void;
  retry: () => void;
  createCategory: (name: string) => void;
}) {
  const [selected, setSelected] = useState(
    widgetBudget?.budget || ledger.planning.budgets[0]?.id || "",
  );
  const [month, setMonth] = useState("");
  const [initialCategory, setInitialCategory] = useState(widgetBudget?.category);
  useEffect(() => {
    setInitialCategory(undefined);
  }, []);
  const [tools, setTools] = useState<"settings" | "create" | "schedules">();
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
      {ledger.failed > 0 && (
        <Action title="Retry failed operations" secondary disabled={busy} onPress={retry} />
      )}
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
      {budget ? (
        <>
          <View style={styles.between}>
            <View style={styles.grow}>
              <Text style={styles.caption}>{budget.name}</Text>
              <Text accessibilityRole="header" style={styles.heading}>
                {monthName(target)}
              </Text>
            </View>
            <BudgetButton
              label="Previous period"
              glyph="‹"
              disabled={busy || target <= budget.firstMonth}
              onPress={() => setMonth(previousMonth(target))}
            />
            <BudgetButton
              label="Next period"
              glyph="›"
              disabled={busy || target >= "9999-11"}
              onPress={() => setMonth(nextMonth(target))}
            />
          </View>
          <Period
            initialCategory={initialCategory}
            draftGuard={draftGuard}
            key={budget.id + "/" + target}
            ledger={ledger}
            budget={budget}
            month={target}
            date={financialDate}
            error={error}
            busy={busy}
            save={save}
            createCategory={createCategory}
          />
        </>
      ) : (
        <View style={{ gap: spacing.small }}>
          <Heading>Create your first budget</Heading>
          <Label muted>Choose the accounts to track and the day your monthly plan begins.</Label>
          <Action title="Create budget" onPress={() => setTools("create")} disabled={busy} />
        </View>
      )}
      <View style={styles.between}>
        <BudgetButton
          label="Budget settings"
          disabled={busy}
          onPress={() => setTools("settings")}
        />
        <BudgetButton label="Sync now" disabled={busy} onPress={sync} />
      </View>
      {tools && (
        <BudgetSheet
          draftGuard={tools !== "settings" ? draftGuard : undefined}
          title={
            tools === "settings"
              ? "Budget settings"
              : tools === "create"
                ? "New budget"
                : "Recurring payments"
          }
          busy={busy}
          close={() => setTools(undefined)}
          error={error}
        >
          {tools === "settings" ? (
            <>
              {ledger.planning.budgets.length > 0 && (
                <Selection
                  label="Budget"
                  value={budget?.id ?? ""}
                  options={ledger.planning.budgets}
                  disabled={busy}
                  onChange={(id) => {
                    if (id) {
                      setSelected(id);
                      setMonth("");
                      setTools(undefined);
                    }
                  }}
                />
              )}
              <View style={styles.card}>
                <BudgetRow label="New budget" onPress={() => setTools("create")} disabled={busy} />
                <BudgetRow
                  label="Recurring payments"
                  onPress={() => setTools("schedules")}
                  disabled={busy}
                />
              </View>
            </>
          ) : tools === "create" ? (
            <BudgetSetup
              ledger={ledger}
              busy={busy}
              save={save}
              done={(id) => {
                setSelected(id);
                setMonth("");
                setTools(undefined);
              }}
            />
          ) : (
            <Schedules ledger={ledger} busy={busy} save={save} />
          )}
        </BudgetSheet>
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

const rhythmNames = { monthly: "Monthly", weekly: "Weekly", daily: "Daily" } as const;

type Summary = NonNullable<ReturnType<typeof periodSummary>>;
const panelTitles = {
  allocation: "Allocate funds",
  details: "Period details",
  reserved: "Reserved bills",
  choose: "Choose a category",
  payments: "Expected payments",
};

type PeriodPanel =
  | { kind: "allocation" | "details" | "payments" | "reserved" | "choose" }
  | { kind: "category"; id: string }
  | { kind: "edit"; id: string; month: string };

function Period({
  draftGuard,
  initialCategory,
  ledger,
  budget,
  month,
  date,
  busy,
  error,
  save,
  createCategory,
}: {
  draftGuard: RefObject<boolean>;
  initialCategory?: string | undefined;
  ledger: Ledger;
  budget: typeof Budget.Type;
  month: string;
  date: string;
  busy: boolean;
  error: string;
  save: Save;
  createCategory: (name: string) => void;
}) {
  const [panel, setPanel] = useState<PeriodPanel | undefined>(() =>
    initialCategory ? { kind: "category", id: initialCategory } : undefined,
  );
  const close = () => setPanel(undefined);
  const currency = budget.currency;
  let summary: ReturnType<typeof periodSummary>;
  const missing: ReturnType<typeof missingOccurrences> = [];
  let start = "";
  let end = "";
  try {
    start = monthStart(month, budget.startDay);
    end = monthStart(nextMonth(month), budget.startDay);
    if (
      !ledger.planningConflict &&
      !ledger.deferredTransactions.some((row) => budget.accountIds.includes(row.accountId))
    ) {
      summary = periodSummary(ledger.planning, budget.id, month, ledger.transactions, date);
      for (
        let cursor = budget.firstMonth, n = 0;
        cursor <= month && n < 1200;
        cursor = nextMonth(cursor), n++
      )
        missing.push(...missingOccurrences(ledger.planning, budget.id, cursor));
    }
  } catch {
    summary = undefined;
  }
  const occurrences = ledger.planning.occurrences.filter(
    (row) => budget.accountIds.includes(row.accountId) && row.date >= start && row.date < end,
  );
  const allocations =
    ledger.planning.periods.find((row) => row.budgetId === budget.id && row.month === month)
      ?.allocations ?? {};
  const selected = panel && "id" in panel ? panel.id : "";
  const categoryName = ledger.categories.find((row) => row.id === selected)?.name;
  const weekRows = summary?.pacing[selected] ?? [];
  const availableIds = summary
    ? [...new Set([...Object.keys(summary.remaining), ...Object.keys(summary.rhythms)])]
    : [];
  let editSummary: Summary | undefined;
  if (summary && panel?.kind === "edit") {
    if (panel.month === month) editSummary = summary;
    else
      try {
        editSummary = periodSummary(
          ledger.planning,
          budget.id,
          panel.month,
          ledger.transactions,
          date,
        );
      } catch {
        editSummary = undefined;
      }
  }
  return (
    <View style={{ gap: spacing.medium }}>
      {summary ? (
        <>
          <View style={[styles.hero, summary.unassigned < 0 && styles.deficit]}>
            <View style={styles.between}>
              <View style={styles.grow}>
                <Text style={styles.heroLabel}>Monthly unbudgeted</Text>
                <Text style={styles.heroAmount} numberOfLines={1} adjustsFontSizeToFit>
                  {money(summary.unassigned, currency)}
                </Text>
              </View>
              <BudgetButton
                light
                label="Allocate"
                disabled={busy}
                onPress={() => setPanel({ kind: "allocation" })}
              />
            </View>
            <View style={styles.heroFoot}>
              <View>
                <Text style={styles.heroLabel}>Expected income</Text>
                <Text style={styles.heroValue}>{money(summary.expectedIncome, currency)}</Text>
              </View>
              <View>
                <Text style={styles.heroLabel}>Reserved bills</Text>
                <Text style={styles.heroValue}>{money(summary.commitments, currency)}</Text>
              </View>
            </View>
          </View>
          <View style={{ gap: spacing.small }}>
            <View style={styles.between}>
              <Text accessibilityRole="header" style={styles.section}>
                Categories
              </Text>
              <Text style={styles.caption}>{dateRange(start, end)}</Text>
            </View>
            {availableIds.length > 0 ? (
              <View style={styles.card}>
                {availableIds.map((id) => {
                  const category = ledger.categories.find((row) => row.id === id);
                  const rhythm = summary.rhythms[id] ?? "monthly";
                  const week = summary.pacing[id]?.find(
                    (row) => row.start <= date && date < row.end,
                  );
                  const remaining =
                    week?.leftToday ??
                    (week ? week.limit - week.spent : (summary.remaining[id] ?? 0));
                  const caption =
                    typeof week?.leftToday === "number"
                      ? "left today"
                      : week
                        ? "left this week"
                        : "left in period";
                  return (
                    <BudgetRow
                      key={id}
                      label={category?.name ?? "Uncategorized"}
                      note={
                        rhythm === "daily"
                          ? "Daily allowance"
                          : rhythm === "weekly"
                            ? "Weekly limit"
                            : "Monthly allocation"
                      }
                      value={money(remaining, currency)}
                      caption={caption}
                      negative={remaining < 0}
                      disabled={busy}
                      onPress={() => setPanel({ kind: "category", id })}
                    />
                  );
                })}
              </View>
            ) : (
              <Label muted>Set an allocation to start tracking a category.</Label>
            )}
            {ledger.categories.some((row) => !availableIds.includes(row.id)) && (
              <BudgetButton
                label="Plan another category"
                onPress={() => setPanel({ kind: "choose" })}
                disabled={busy}
              />
            )}
          </View>
        </>
      ) : (
        <Label>
          Availability unavailable. Finish synchronization or resolve planning conflicts, then check
          the period and amounts.
        </Label>
      )}
      <View style={styles.card}>
        <BudgetRow
          label="Period details"
          onPress={() => setPanel({ kind: "details" })}
          disabled={busy}
        />
        <BudgetRow
          label="Expected payments"
          note={
            missing.length ? `${missing.length} missing estimates · totals incomplete` : undefined
          }
          value={String(occurrences.length)}
          onPress={() => setPanel({ kind: "payments" })}
          disabled={busy}
        />
      </View>
      {panel && (
        <BudgetSheet
          draftGuard={
            ["edit", "allocation", "reserved", "payments"].includes(panel.kind)
              ? draftGuard
              : undefined
          }
          title={
            panel.kind === "category" || panel.kind === "edit"
              ? (categoryName ?? "Uncategorized")
              : panelTitles[panel.kind]
          }
          error={error}
          busy={busy}
          close={close}
        >
          {panel.kind === "allocation" && (
            <>
              <Label muted>{monthName(month)}</Label>
              <PlanEditor
                ledger={ledger}
                budget={budget}
                month={month}
                busy={busy}
                save={save}
                done={close}
                createCategory={createCategory}
              />
            </>
          )}
          {panel.kind === "details" && (
            <>
              <Heading>{monthName(month)}</Heading>
              {end !== "" && (
                <Label muted>
                  {dateRange(start, end)} · {currency}
                </Label>
              )}
              {summary && (
                <View style={styles.card}>
                  <BudgetRow
                    label="Expected income"
                    value={money(summary.expectedIncome, currency)}
                  />
                  <BudgetRow label="Posted income" value={money(summary.postedIncome, currency)} />
                  <BudgetRow label="Reserved bills" value={money(summary.commitments, currency)} />
                  <BudgetRow
                    label="Prior overspending"
                    value={money(summary.overspending, currency)}
                  />
                  <BudgetRow label="Assignable" value={money(summary.assignable, currency)} />
                  <BudgetRow
                    label="Unbudgeted"
                    value={money(summary.unassigned, currency)}
                    negative={summary.unassigned < 0}
                  />
                </View>
              )}
              <Action
                title="Edit forecast and allocations"
                disabled={busy}
                onPress={() => setPanel({ kind: "allocation" })}
              />
              <Action
                title="Change reserved bills"
                secondary
                disabled={busy}
                onPress={() => setPanel({ kind: "reserved" })}
              />
            </>
          )}
          {panel.kind === "reserved" && (
            <ReservationEditor
              ledger={ledger}
              budget={budget}
              month={month}
              busy={busy}
              save={save}
              done={close}
            />
          )}
          {panel.kind === "choose" && (
            <View style={styles.card}>
              {ledger.categories
                .filter((row) => !availableIds.includes(row.id))
                .map((row) => (
                  <BudgetRow
                    key={row.id}
                    label={row.name}
                    disabled={busy}
                    onPress={() => setPanel({ kind: "category", id: row.id })}
                  />
                ))}
            </View>
          )}
          {panel.kind === "category" && !summary && (
            <Label>Availability unavailable. Finish synchronization to reopen this plan.</Label>
          )}
          {panel.kind === "category" && summary && (
            <>
              <Text style={styles.caption}>{monthName(month)}</Text>
              <View style={styles.card}>
                <BudgetRow
                  label="Monthly allocation"
                  value={money(allocations[selected] ?? 0, currency)}
                />
                <BudgetRow
                  label="Net spending"
                  value={money(summary.spending[selected] ?? 0, currency)}
                />
                <BudgetRow
                  label="Period remaining"
                  value={money(summary.remaining[selected] ?? 0, currency)}
                />
              </View>
              {categoryName && (
                <>
                  <Action
                    title="Edit this period"
                    disabled={busy}
                    onPress={() => setPanel({ kind: "edit", id: selected, month })}
                  />
                  {month < "9999-11" && (
                    <Action
                      title="Plan next period"
                      secondary
                      disabled={busy}
                      onPress={() =>
                        setPanel({ kind: "edit", id: selected, month: nextMonth(month) })
                      }
                    />
                  )}
                </>
              )}
              {weekRows.length > 0 && (
                <>
                  <Text accessibilityRole="header" style={styles.section}>
                    Weekly limits
                  </Text>
                  <View style={styles.card}>
                    {weekRows.map((week) => (
                      <BudgetRow
                        key={week.start}
                        label={dateRange(week.start, week.end)}
                        note={week.fixed ? "Fixed" : "Automatic"}
                        value={money(week.limit, currency)}
                        caption={money(week.spent, currency) + " spent"}
                      />
                    ))}
                  </View>
                </>
              )}
            </>
          )}
          {panel.kind === "edit" &&
            (editSummary ? (
              <CategoryPacingEditor
                key={selected + panel.month}
                ledger={ledger}
                budget={budget}
                month={panel.month}
                category={selected}
                busy={busy}
                save={save}
                done={close}
                summary={editSummary}
              />
            ) : (
              <Label>
                Availability unavailable. Check synchronization and the period before editing this
                plan.
              </Label>
            ))}
          {panel.kind === "payments" && (
            <>
              {missing.length > 0 && (
                <>
                  <Label>
                    {missing.length} recurring estimates are missing. Totals include generated
                    payments only.
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
                </>
              )}
              {occurrences.length === 0 && (
                <Label muted>No generated payments in this period.</Label>
              )}
              {occurrences.map((row) => (
                <OccurrenceEditor
                  key={row.id + "/" + row.revision}
                  occurrenceId={row.id}
                  ledger={ledger}
                  busy={busy}
                  save={save}
                />
              ))}
            </>
          )}
        </BudgetSheet>
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
}: {
  ledger: Ledger;
  budget: typeof Budget.Type;
  month: string;
  busy: boolean;
  save: Save;
  done: () => void;
  category: string;
  summary: Summary;
}) {
  const [plan] = useState(() =>
    ledger.planning.periods.find((row) => row.budgetId === budget.id && row.month === month),
  );
  const [allocation, setAllocation] = useState(
    plan?.allocations[category] === undefined
      ? ""
      : decimal(plan.allocations[category], budget.currency),
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
  const [preview, setPreview] = useState<{
    command: Extract<PlanningCommand, { type: "plan" }>;
    after: Summary;
    currentImpact?: string;
    beforeToday: number | null;
    afterToday: number | null;
  }>();
  const [error, setError] = useState("");
  const start = monthStart(month, budget.startDay);
  const weeks = periodWeeks(start, monthStart(nextMonth(month), budget.startDay));
  const [selectedWeek, setSelectedWeek] = useState(
    () => weeks.find((week) => week.start <= today() && today() < week.end)?.start ?? start,
  );
  const [showOtherWeeks, setShowOtherWeeks] = useState(false);
  const allocatingCarry = rhythm !== "monthly" && opening > 0;
  function previewPlan() {
    setShowOtherWeeks(false);
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
      const allocations = { ...plan?.allocations };
      if (allocation.trim()) {
        const amount = parseMoney(allocation.trim(), budget.currency);
        if (amount < 0) throw new Error("Enter an allocation of zero or more");
        allocations[category] = amount;
      } else delete allocations[category];
      const command: PlanningCommand = {
        type: "plan",
        operationId: randomUUID(),
        revision: plan?.revision ?? 0,
        value: Schema.decodeUnknownSync(BudgetPeriod)({
          budgetId: budget.id,
          month,
          incomeForecast: plan?.incomeForecast ?? null,
          allocations,
          categoryPlans,
        }),
      };
      const projected = projectPlanning(ledger.planning, [command]);
      const after = periodSummary(projected, budget.id, month, ledger.transactions);
      if (!after) throw new Error("Period unavailable");
      const leftToday = (period: Summary | undefined) =>
        period?.pacing[category]?.find((week) => week.leftToday !== null)?.leftToday ?? null;
      let beforeToday = leftToday(summary);
      let afterToday = leftToday(after);
      let currentImpact: string | undefined;
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
        beforeToday = leftToday(beforeCurrent);
        afterToday = leftToday(afterCurrent);
        if (beforeCurrent && afterCurrent)
          currentImpact = `${monthName(current)} unbudgeted: ${money(beforeCurrent.unassigned, budget.currency)} → ${money(afterCurrent.unassigned, budget.currency)}`;
      }
      setPreview({
        command,
        after,
        beforeToday,
        afterToday,
        ...(currentImpact ? { currentImpact } : {}),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Invalid category plan");
    }
  }
  if (preview)
    return (
      <>
        <View>
          <Text style={styles.caption}>{monthName(month)}</Text>
          <Heading>Review plan</Heading>
        </View>
        <View style={[styles.hero, preview.after.unassigned < 0 && styles.deficit]}>
          <Text style={styles.heroLabel}>Monthly unbudgeted after saving</Text>
          <Text style={styles.heroAmount}>{money(preview.after.unassigned, budget.currency)}</Text>
          <Text style={styles.heroLabel}>
            Previously {money(summary.unassigned, budget.currency)}
          </Text>
        </View>
        {preview.beforeToday !== preview.afterToday && (
          <View style={styles.card}>
            <BudgetRow
              label="Left today"
              note={
                preview.beforeToday === null
                  ? "Previously no daily allowance"
                  : "Previously " + money(preview.beforeToday, budget.currency)
              }
              value={
                preview.afterToday === null
                  ? "No daily allowance"
                  : money(preview.afterToday, budget.currency)
              }
              negative={preview.afterToday !== null && preview.afterToday < 0}
            />
          </View>
        )}
        {preview.currentImpact && <Label>{preview.currentImpact}</Label>}
        <View style={styles.card}>
          <BudgetRow
            label="Monthly allocation"
            value={money(preview.command.value.allocations[category] ?? 0, budget.currency)}
          />
          <BudgetRow label="Planning rhythm" value={rhythmNames[rhythm]} />
          {preview.after.pacing[category]
            ?.filter((week) => week.start === selectedWeek)
            .map((week) => (
              <BudgetRow
                key={week.start}
                label={dateRange(week.start, week.end)}
                note={week.fixed ? "Fixed" : "Automatic"}
                value={money(week.limit, budget.currency)}
              />
            ))}
        </View>
        <Action
          title="Save category plan"
          disabled={busy}
          onPress={() => save(() => [preview.command], done)}
        />
        <BudgetButton label="Keep editing" disabled={busy} onPress={() => setPreview(undefined)} />
        {preview.after.pacing[category] && (
          <>
            <BudgetButton
              label={showOtherWeeks ? "Hide other weeks" : "View other weeks"}
              onPress={() => setShowOtherWeeks(!showOtherWeeks)}
            />
            {showOtherWeeks && (
              <View style={styles.card}>
                {preview.after.pacing[category]
                  .filter((week) => week.start !== selectedWeek)
                  .map((week) => (
                    <BudgetRow
                      key={week.start}
                      label={dateRange(week.start, week.end)}
                      note={week.fixed ? "Fixed" : "Automatic"}
                      value={money(week.limit, budget.currency)}
                    />
                  ))}
              </View>
            )}
          </>
        )}
      </>
    );
  return (
    <>
      <View>
        <Text style={styles.caption}>Plan for</Text>
        <Heading>{monthName(month)}</Heading>
        <Text style={styles.caption}>
          {dateRange(start, monthStart(nextMonth(month), budget.startDay))}
        </Text>
      </View>
      <Field
        label={`Monthly allocation (${budget.currency})`}
        value={allocation}
        onChangeText={setAllocation}
        keyboardType="decimal-pad"
        editable={!busy}
        placeholder="0"
      />
      <View style={{ gap: spacing.small }}>
        <Label>Planning rhythm</Label>
        <View style={styles.segments}>
          {(["monthly", "weekly", "daily"] as const).map((value) => (
            <Pressable
              key={value}
              accessibilityRole="radio"
              accessibilityLabel={rhythmNames[value]}
              accessibilityState={{ checked: rhythm === value, disabled: busy }}
              disabled={busy}
              onPress={() => setRhythm(value)}
              style={[styles.segment, rhythm === value && styles.selected]}
            >
              <Text style={[styles.buttonText, rhythm === value && styles.lightText]}>
                {rhythmNames[value]}
              </Text>
            </Pressable>
          ))}
        </View>
        <Label muted>
          {rhythm === "monthly"
            ? "Keep funds in this category across periods."
            : rhythm === "weekly"
              ? "Split the allocation into weekly limits."
              : "Divide each week's remaining funds across its remaining days."}
        </Label>
      </View>
      {allocatingCarry && (
        <>
          <Label>
            Opening balance {money(opening, budget.currency)}. Any amount you leave out returns to
            unbudgeted.
          </Label>
          <Field
            label="Carry into weeks"
            value={carry}
            onChangeText={setCarry}
            editable={!busy}
            keyboardType="decimal-pad"
          />
        </>
      )}
      {rhythm !== "monthly" && (
        <View style={{ gap: spacing.small }}>
          <Text accessibilityRole="header" style={styles.section}>
            Weekly limits
          </Text>
          <Selection
            label="Week"
            value={selectedWeek}
            options={weeks.map((w) => ({ id: w.start, name: dateRange(w.start, w.end) }))}
            disabled={busy}
            onChange={(id) => {
              if (id) setSelectedWeek(id);
            }}
          />
          <Field
            label={`Fixed weekly limit (${budget.currency})`}
            value={limits[selectedWeek] ?? ""}
            onChangeText={(value) => setLimits({ ...limits, [selectedWeek]: value })}
            keyboardType="decimal-pad"
            editable={!busy}
            placeholder="Automatic"
          />
          <Label muted>Leave blank to use this week's share of the monthly allocation.</Label>
        </View>
      )}
      {error !== "" && (
        <Text accessibilityRole="alert" style={styles.negative}>
          {error}
        </Text>
      )}
      <Action title="Review plan" disabled={busy} onPress={previewPlan} />
    </>
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
