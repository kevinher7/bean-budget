import { useEffect, useState } from "react";
import {
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { Effect } from "effect";
import {
  initialize,
  loadLedger,
  createAccount,
  saveTransaction,
  saveClassification,
  postTransaction,
  editTransaction,
  retryFailed,
  synchronize,
  resolveConflict,
  acceptServer,
} from "./storage.ts";
import { loadConnection, saveConnection } from "./connection.ts";
import { Action, Field, Heading, Label, Selection, TextAction } from "./ui/controls.tsx";
import { colors, spacing } from "./ui/theme.ts";

type Ledger = Effect.Success<ReturnType<typeof loadLedger>>;

function today() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function money(amount: number, currency: "JPY" | "USD") {
  return new Intl.NumberFormat(currency === "JPY" ? "ja-JP" : "en-US", {
    style: "currency",
    currency,
  }).format(currency === "USD" ? amount / 100 : amount);
}

export default function App() {
  const [ledger, setLedger] = useState<Ledger>();
  const [selected, setSelected] = useState("");
  const [screen, setScreen] = useState<"register" | "entry" | "account" | "connection">("register");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(today);
  const [editId, setEditId] = useState<string>();
  const [income, setIncome] = useState(false);
  const [pending, setPending] = useState(false);
  const [category, setCategory] = useState("");
  const [payee, setPayee] = useState("");
  const [notes, setNotes] = useState("");
  const [classificationName, setClassificationName] = useState("");
  const [classificationKind, setClassificationKind] = useState<"category" | "payee">();
  const [name, setName] = useState("");
  const [currency, setCurrency] = useState<"JPY" | "USD">("JPY");
  const [opening, setOpening] = useState("0");
  const [url, setUrl] = useState("http://10.0.2.2:3000");
  const [token, setToken] = useState("");
  const [connection, setConnection] = useState<Effect.Success<typeof loadConnection>>(null);
  const account = ledger?.accounts.find((row) => row.id === selected) ?? ledger?.accounts[0];

  const transactions = (
    ledger?.transactions.filter((row) => row.accountId === account?.id) ?? []
  ).sort((left, right) => right.date.localeCompare(left.date));

  useEffect(() => {
    let active = true;
    Effect.runPromise(
      Effect.all({
        ledger: initialize.pipe(Effect.andThen(loadLedger)),
        connection: loadConnection,
      }),
    ).then(
      (result) => {
        if (!active) return;
        setLedger(result.ledger);
        setConnection(result.connection);
        if (result.connection) setUrl(result.connection.url);
        setBusy(false);
      },
      () => {
        if (active) {
          setError("Cannot open local data or saved connection. Reopen the app to retry.");
          setBusy(false);
        }
      },
    );
    return () => {
      active = false;
    };
  }, []);

  function run<A, E>(effect: Effect.Effect<A, E>, onSuccess: (value: A) => void) {
    if (busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    Effect.runPromise(
      effect.pipe(
        Effect.mapError((failure) => {
          if (
            failure &&
            typeof failure === "object" &&
            "_tag" in failure &&
            (failure._tag === "ConnectionError" || failure._tag === "LocalStorageError") &&
            "message" in failure &&
            typeof failure.message === "string"
          )
            setError(failure.message);
          else
            setError(
              "Could not complete this action. Check the fields and connection, then retry. Your entry is retained.",
            );
          return failure;
        }),
      ),
    ).then(
      (value) => {
        onSuccess(value);
        setBusy(false);
      },
      () => {
        setBusy(false);
        Effect.runPromise(loadLedger()).then(setLedger, () =>
          setError("Cannot read local data. Reopen the app to retry."),
        );
      },
    );
  }

  function sync() {
    if (!connection) {
      setScreen("connection");
      return;
    }
    run(synchronize(connection), (value) => {
      setLedger(value);
      setMessage("Synchronization finished.");
    });
  }

  return (
    <View style={styles.safeScreen}>
      <StatusBar barStyle="dark-content" />
      <KeyboardAvoidingView style={styles.screen} behavior="height">
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={[styles.page, screen === "entry" && styles.entryPage]}
        >
          <View style={styles.header}>
            <Heading>
              {screen === "register"
                ? "Bean Budget"
                : screen === "entry"
                  ? editId
                    ? "Edit transaction"
                    : "Add transaction"
                  : screen === "account"
                    ? "New account"
                    : "Connection"}
            </Heading>
            {screen !== "register" && (
              <Action
                title="Back"
                secondary
                onPress={() => {
                  setScreen("register");
                  setError("");
                }}
                disabled={busy}
              />
            )}
          </View>
          {error !== "" && (
            <Text accessibilityRole="alert" style={styles.error}>
              {error}
            </Text>
          )}
          {message !== "" && <Label>{message}</Label>}
          {busy && <Label muted>Working...</Label>}
          {screen === "register" && (
            <>
              <View style={styles.row}>
                <TextAction
                  title="New account"
                  disabled={busy || !ledger}
                  onPress={() => setScreen("account")}
                />
                <TextAction
                  title="Connection"
                  disabled={busy}
                  onPress={() => setScreen("connection")}
                />
              </View>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.accountTabs}
              >
                {ledger?.accounts.map((row) => (
                  <TextAction
                    key={row.id}
                    title={`${row.name} · ${row.currency}`}
                    selected={account?.id === row.id}
                    disabled={busy}
                    onPress={() => setSelected(row.id)}
                  />
                ))}
              </ScrollView>
              {account ? (
                <>
                  <View style={styles.balances}>
                    <Text style={styles.balance}>{money(account.balance, account.currency)}</Text>
                    <Label muted>Posted · {account.currency}</Label>
                    <Label muted>
                      Projected {money(account.projectedBalance, account.currency)}
                    </Label>
                  </View>
                  <Action
                    title="Add transaction"
                    disabled={busy}
                    onPress={() => {
                      setEditId(undefined);
                      setClassificationKind(undefined);
                      setClassificationName("");
                      setError("");
                      setMessage("");
                      setAmount("");
                      setNotes("");
                      setDate(today());
                      setScreen("entry");
                    }}
                  />
                  <View style={styles.section}>
                    <Heading>Transactions</Heading>
                    {transactions.length === 0 && (
                      <Label muted>No transactions yet. Add an expense or income.</Label>
                    )}
                    {transactions.map((row, index) => (
                      <View key={row.id}>
                        {(index === 0 || transactions[index - 1]?.date !== row.date) && (
                          <Text accessibilityRole="header" style={styles.day}>
                            {row.date}
                          </Text>
                        )}
                        <View style={styles.transaction}>
                          <Pressable
                            accessibilityRole={
                              row.kind === "transaction" && !row.transferId ? "button" : undefined
                            }
                            accessibilityLabel={
                              row.kind === "transaction" && !row.transferId
                                ? `Edit ${row.amount < 0 ? "expense" : "income"}, ${money(row.amount, account.currency)}, ${row.date}`
                                : undefined
                            }
                            accessibilityState={{
                              disabled:
                                busy || row.kind !== "transaction" || Boolean(row.transferId),
                            }}
                            disabled={busy || row.kind !== "transaction" || Boolean(row.transferId)}
                            style={({ pressed }) => [
                              styles.transactionBody,
                              pressed && styles.pressed,
                            ]}
                            onPress={() => {
                              setEditId(row.id);
                              setClassificationKind(undefined);
                              setClassificationName("");
                              setError("");
                              setMessage("");
                              setAmount(
                                String(
                                  Math.abs(row.amount) / (account.currency === "USD" ? 100 : 1),
                                ),
                              );
                              setDate(row.date);
                              setIncome(row.amount > 0);
                              setPending(row.status === "pending");
                              setCategory(row.categoryId ?? "");
                              setPayee(row.payeeId ?? "");
                              setNotes(row.notes ?? "");
                              setScreen("entry");
                            }}
                          >
                            <View style={styles.header}>
                              <View style={styles.transactionText}>
                                <Label>
                                  {row.kind === "opening"
                                    ? "Opening balance"
                                    : (ledger?.payees.find((value) => value.id === row.payeeId)
                                        ?.name ?? (row.amount < 0 ? "Expense" : "Income"))}
                                </Label>
                                <Label muted>
                                  {ledger?.categories.find((value) => value.id === row.categoryId)
                                    ?.name ?? "Uncategorized"}
                                </Label>
                              </View>
                              <Text style={styles.amount}>
                                {money(row.amount, account.currency)}
                              </Text>
                            </View>
                            {row.notes && <Label muted>{row.notes}</Label>}
                            <Label muted>
                              {row.status === "pending" ? "Bank pending" : "Posted"} ·{" "}
                              {row.syncStatus === "synced"
                                ? "Synced"
                                : row.syncStatus === "failed"
                                  ? "Sync failed"
                                  : "Waiting to sync"}
                            </Label>
                            {row.syncError && <Text style={styles.error}>{row.syncError}</Text>}
                          </Pressable>
                          {row.kind === "transaction" &&
                            !row.transferId &&
                            row.status === "pending" && (
                              <TextAction
                                title="Post transaction"
                                disabled={busy}
                                onPress={() => run(postTransaction(row.id), setLedger)}
                              />
                            )}
                          {row.syncStatus === "failed" && (
                            <View style={styles.row}>
                              <TextAction
                                title="Keep local edit"
                                disabled={busy}
                                onPress={() => run(resolveConflict(row.id), setLedger)}
                              />
                              <TextAction
                                title="Use server"
                                disabled={busy}
                                onPress={() => run(acceptServer(row.id), setLedger)}
                              />
                            </View>
                          )}
                        </View>
                      </View>
                    ))}
                  </View>
                </>
              ) : (
                <Label>No accounts yet. Create an account to start your register.</Label>
              )}
              <View style={styles.sync}>
                <Label muted>
                  {ledger?.pending ?? 0} waiting to sync · {ledger?.failed ?? 0} failed
                </Label>
                <TextAction title="Sync now" disabled={busy || !ledger} onPress={sync} />
                {(ledger?.failed ?? 0) > 0 && (
                  <TextAction
                    title="Retry failed operations"
                    disabled={busy}
                    onPress={() => run(retryFailed(), setLedger)}
                  />
                )}
              </View>
            </>
          )}
          {screen === "account" && (
            <>
              <Field label="Account name" value={name} onChangeText={setName} editable={!busy} />
              <Label>Currency</Label>
              <View style={styles.row}>
                {(["JPY", "USD"] as const).map((value) => (
                  <Action
                    key={value}
                    title={value}
                    secondary
                    selected={currency === value}
                    disabled={busy}
                    onPress={() => setCurrency(value)}
                  />
                ))}
              </View>
              <Field
                label={`Opening balance · ${currency}`}
                value={opening}
                onChangeText={setOpening}
                editable={!busy}
                keyboardType="numbers-and-punctuation"
              />
              <Field
                label="Opening date"
                placeholder="YYYY-MM-DD"
                value={date}
                onChangeText={setDate}
                editable={!busy}
              />
              <Action
                title="Create account"
                disabled={busy || !name.trim()}
                onPress={() =>
                  run(createAccount({ name, currency, openingBalance: opening, date }), (value) => {
                    setLedger(value);
                    setName("");
                    setOpening("0");
                    setScreen("register");
                    setSelected(value.accounts.at(-1)?.id ?? "");
                  })
                }
              />
            </>
          )}
          {screen === "entry" && account && (
            <>
              <Label>
                {account.name} · {account.currency}
              </Label>
              <View style={styles.row}>
                <Action
                  title="Expense"
                  secondary
                  selected={!income}
                  disabled={busy || Boolean(editId)}
                  onPress={() => setIncome(false)}
                />
                <Action
                  title="Income"
                  secondary
                  selected={income}
                  disabled={busy || Boolean(editId)}
                  onPress={() => setIncome(true)}
                />
              </View>
              <View style={styles.entryColumns}>
                <View style={styles.entryColumn}>
                  <Field
                    label={`Amount · ${account.currency}`}
                    value={amount}
                    onChangeText={setAmount}
                    editable={!busy && !editId}
                    inputMode="decimal"
                    keyboardType="decimal-pad"
                    returnKeyType="done"
                    placeholder={account.currency === "USD" ? "0.00" : "0"}
                  />
                </View>
                <View style={styles.entryColumn}>
                  <Field
                    label="Date"
                    value={date}
                    onChangeText={setDate}
                    editable={!busy && !editId}
                    placeholder="YYYY-MM-DD"
                  />
                </View>
              </View>
              <View style={styles.header}>
                <Label>{pending ? "Bank pending" : "Posted"}</Label>
                <Switch
                  accessibilityLabel="Bank pending"
                  value={pending}
                  onValueChange={setPending}
                  disabled={busy || Boolean(editId)}
                  trackColor={colors.switchTrack}
                  thumbColor={colors.surface}
                />
              </View>
              {(["category", "payee"] as const).map((kind) => (
                <View key={kind} style={styles.classification}>
                  <Selection
                    label={kind === "category" ? "Category" : "Payee"}
                    emptyLabel={kind === "category" ? "Uncategorized" : "None"}
                    value={kind === "category" ? category : payee}
                    options={(kind === "category" ? ledger?.categories : ledger?.payees) ?? []}
                    onChange={kind === "category" ? setCategory : setPayee}
                    disabled={busy}
                    onAdd={() => {
                      setClassificationKind(classificationKind === kind ? undefined : kind);
                      setClassificationName("");
                    }}
                  />
                  {classificationKind === kind && (
                    <>
                      <Field
                        label={kind === "category" ? "New category" : "New payee"}
                        value={classificationName}
                        onChangeText={setClassificationName}
                        editable={!busy}
                        autoFocus
                      />
                      <View style={styles.row}>
                        <Action
                          title="Add"
                          disabled={busy || !classificationName.trim()}
                          onPress={() =>
                            run(saveClassification(kind, classificationName.trim()), (value) => {
                              setLedger(value);
                              const previous =
                                kind === "category" ? ledger?.categories : ledger?.payees;
                              const created = (
                                kind === "category" ? value.categories : value.payees
                              ).find((row) => !previous?.some((saved) => saved.id === row.id));
                              if (created)
                                (kind === "category" ? setCategory : setPayee)(created.id);
                              setClassificationName("");
                              setClassificationKind(undefined);
                            })
                          }
                        />
                        <Action
                          title="Cancel"
                          secondary
                          disabled={busy}
                          onPress={() => setClassificationKind(undefined)}
                        />
                      </View>
                    </>
                  )}
                </View>
              ))}
              <Field
                label="Notes"
                hideLabel
                placeholder="Notes · optional"
                value={notes}
                onChangeText={setNotes}
                editable={!busy}
              />
              <Action
                title="Save transaction"
                disabled={busy || !amount.trim()}
                onPress={() => {
                  if (!/^\d+(\.\d+)?$/.test(amount.trim())) {
                    setError("Enter a positive amount. Choose Expense or Income above.");
                    return;
                  }
                  if (editId) {
                    run(
                      editTransaction(editId, {
                        status: pending ? "pending" : "posted",
                        categoryId: category || null,
                        payeeId: payee || null,
                        notes: notes || null,
                      }),
                      (value) => {
                        setLedger(value);
                        setEditId(undefined);
                        setScreen("register");
                      },
                    );
                    return;
                  }
                  run(
                    saveTransaction({
                      accountId: account.id,
                      amount: `${income ? "" : "-"}${amount.trim()}`,
                      date,
                      status: pending ? "pending" : "posted",
                      ...(category ? { categoryId: category } : {}),
                      ...(payee ? { payeeId: payee } : {}),
                      ...(notes ? { notes } : {}),
                    }),
                    (value) => {
                      setLedger(value);
                      setAmount("");
                      setNotes("");
                      setScreen("register");
                    },
                  );
                }}
              />
            </>
          )}
          {screen === "connection" && (
            <>
              <Field
                label="Server URL"
                value={url}
                onChangeText={setUrl}
                editable={!busy}
                keyboardType="url"
              />
              <Field
                label="Access token"
                value={token}
                onChangeText={setToken}
                editable={!busy}
                secureTextEntry
                placeholder={
                  connection ? "Enter token to replace saved connection" : "Access token"
                }
              />
              <Label muted>
                {connection
                  ? `Saved server: ${connection.url}`
                  : "No server saved. You can enter transactions offline."}
              </Label>
              <Action
                title="Save connection"
                disabled={busy || !token.trim()}
                onPress={() =>
                  run(saveConnection(url, token), (value) => {
                    setConnection(value);
                    setToken("");
                    setMessage("Connection saved.");
                  })
                }
              />
              <Action title="Sync now" secondary disabled={busy || !connection} onPress={sync} />
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  safeScreen: {
    flex: 1,
    backgroundColor: colors.surface,
    paddingTop: StatusBar.currentHeight ?? 24,
    paddingBottom: 24,
  },
  screen: { flex: 1, backgroundColor: colors.surface },
  page: { padding: spacing.medium, paddingTop: 12, paddingBottom: 24, gap: spacing.small },
  entryPage: { padding: spacing.medium, paddingTop: 8, paddingBottom: 16, gap: 8 },
  entryColumns: { flexDirection: "row", gap: spacing.small },
  entryColumn: { flex: 1 },
  classification: { gap: 4 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.small,
  },
  accountTabs: { flexDirection: "row", gap: spacing.medium },
  row: { flexDirection: "row", flexWrap: "wrap", gap: spacing.small },
  section: {
    gap: spacing.small,
    paddingTop: spacing.medium,
  },
  balances: { gap: 2, paddingVertical: spacing.small },
  sync: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    justifyContent: "space-between",
    gap: spacing.small,
  },
  day: {
    color: colors.secondary,
    fontSize: 14,
    fontWeight: "600",
    paddingTop: 12,
    paddingBottom: 4,
  },
  transactionBody: { minHeight: 48, gap: 2, paddingVertical: 10 },
  pressed: { backgroundColor: colors.selected },
  balance: { color: colors.text, fontSize: 36, fontWeight: "600", fontVariant: ["tabular-nums"] },
  amount: { color: colors.text, fontSize: 17, fontWeight: "600", fontVariant: ["tabular-nums"] },
  transaction: {
    borderBottomWidth: 1,
    borderColor: colors.outline,
  },
  transactionText: { flex: 1 },
  error: { color: colors.error, fontSize: 15, lineHeight: 22 },
});
