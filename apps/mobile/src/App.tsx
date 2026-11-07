import { useEffect, useState } from "react";
import { Button, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Effect } from "effect";
import { initialize, loadLedger, saveTransaction } from "./storage.ts";

export default function App() {
  const [ledger, setLedger] = useState<Effect.Success<ReturnType<typeof loadLedger>>>();
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(() =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date()),
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    let active = true;
    Effect.runPromise(initialize.pipe(Effect.andThen(loadLedger))).then(
      (value) => {
        if (active) {
          setLedger(value);
          setBusy(false);
        }
      },
      () => {
        if (active) {
          setError("Cannot open local ledger. Restart to retry.");
          setBusy(false);
        }
      },
    );
    return () => {
      active = false;
    };
  }, []);
  function save() {
    setBusy(true);
    setError("");
    Effect.runPromise(saveTransaction(amount, date)).then(
      (value) => {
        setLedger(value);
        setAmount("");
        setBusy(false);
      },
      () => {
        setError(
          "Could not save. Check whole yen, YYYY-MM-DD date and balance limits. Your entry is retained.",
        );
        setBusy(false);
      },
    );
  }
  return (
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      <Text style={styles.heading}>Bean Budget</Text>
      <Text>Local cash · JPY · starts at ¥0</Text>
      <Text style={styles.heading}>¥{ledger?.total.toLocaleString("ja-JP") ?? "—"}</Text>
      <Text>Offline only · {ledger?.pending ?? 0} pending operations · sync unavailable</Text>
      <Text>Amount in whole yen (negative for spending)</Text>
      <TextInput
        accessibilityLabel="Amount in yen"
        style={styles.input}
        value={amount}
        onChangeText={setAmount}
        placeholder="-550"
        autoCapitalize="none"
      />
      <Text>Financial date</Text>
      <TextInput
        accessibilityLabel="Financial date"
        style={styles.input}
        value={date}
        onChangeText={setDate}
        placeholder="YYYY-MM-DD"
        autoCapitalize="none"
      />
      <Button
        title={busy ? "Working…" : "Save transaction"}
        disabled={busy || !ledger}
        onPress={save}
      />
      {error ? <Text accessibilityRole="alert">{error}</Text> : null}
      <Text style={styles.heading}>Transactions</Text>
      {ledger?.transactions.length === 0 ? <Text>No transactions yet.</Text> : null}
      {ledger?.transactions.map((row) => (
        <View key={row.id} style={styles.row}>
          <Text>
            {row.date} · ¥{row.amount.toLocaleString("ja-JP")}
          </Text>
          <Text>Pending</Text>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 24, paddingTop: 64, paddingBottom: 48, gap: 16 },
  heading: { fontSize: 28, fontWeight: "600" },
  input: {
    borderWidth: 1,
    borderColor: "#777",
    borderRadius: 8,
    padding: 12,
    color: "#111",
    backgroundColor: "#fff",
  },
  row: { borderBottomWidth: 1, borderColor: "#ddd", paddingVertical: 12 },
});
