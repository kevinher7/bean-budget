import type { ReactNode } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { colors, spacing } from "./theme.ts";

const shortDate = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const longMonth = new Intl.DateTimeFormat("en-US", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

export function monthName(month: string) {
  return longMonth.format(new Date(month + "-01T00:00:00Z"));
}

export function dateRange(start: string, end: string) {
  const last = new Date(Date.parse(end) - 86_400_000);
  return shortDate.format(new Date(start)) + " to " + shortDate.format(last);
}

export function BudgetSheet({
  title,
  children,
  close,
  busy,
  error,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
  busy: boolean;
  error: string;
}) {
  return (
    <Modal
      transparent
      visible
      animationType="slide"
      onRequestClose={() => {
        if (!busy) close();
      }}
    >
      <View style={styles.backdrop}>
        <Pressable
          style={StyleSheet.absoluteFill}
          accessible={false}
          onPress={close}
          disabled={busy}
        />
        <KeyboardAvoidingView style={styles.sheet} behavior="height">
          <View style={styles.sheetHeader}>
            <Text accessibilityRole="header" style={[styles.heading, styles.grow]}>
              {title}
            </Text>
            <BudgetButton label="Close" onPress={close} disabled={busy} />
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.sheetBody}>
            {error !== "" && (
              <Text accessibilityRole="alert" style={styles.negative}>
                {error}
              </Text>
            )}
            {children}
          </ScrollView>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

export function BudgetButton({
  label,
  onPress,
  disabled = false,
  glyph,
  light = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  glyph?: string;
  light?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.compactButton,
        light && styles.lightButton,
        (disabled || pressed) && styles.dim,
      ]}
    >
      <Text
        style={[styles.buttonText, glyph !== undefined && styles.glyph, light && styles.lightText]}
      >
        {glyph ?? label}
      </Text>
    </Pressable>
  );
}

export function BudgetRow({
  label,
  note,
  value,
  caption,
  negative = false,
  onPress,
  disabled = false,
}: {
  label: string;
  note?: string | undefined;
  value?: string;
  caption?: string;
  negative?: boolean;
  onPress?: () => void;
  disabled?: boolean;
}) {
  const content = (
    <>
      <View style={styles.grow}>
        <Text style={styles.rowName}>{label}</Text>
        {note !== undefined && <Text style={styles.caption}>{note}</Text>}
      </View>
      {value !== undefined && (
        <View style={styles.trailing}>
          <Text style={[styles.amount, negative && styles.negative]}>{value}</Text>
          {caption !== undefined && <Text style={styles.caption}>{caption}</Text>}
        </View>
      )}
      {onPress && (
        <Text importantForAccessibility="no" style={styles.chevron}>
          ›
        </Text>
      )}
    </>
  );
  return onPress ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[label, note, value, caption].filter(Boolean).join(", ")}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.dim]}
    >
      {content}
    </Pressable>
  ) : (
    <View style={styles.row}>{content}</View>
  );
}

export const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: colors.scrim },
  sheet: {
    maxHeight: "92%",
    backgroundColor: colors.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    flexShrink: 1,
  },
  sheetHeader: {
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderColor: colors.outline,
    flexDirection: "row",
    gap: 8,
    alignItems: "center",
  },
  sheetBody: { padding: 20, gap: spacing.medium, paddingBottom: 32 },
  heading: { color: colors.text, fontSize: 22, fontWeight: "700" },
  section: { color: colors.text, fontSize: 19, fontWeight: "700" },
  compactButton: {
    minHeight: 48,
    minWidth: 48,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 9,
  },
  lightButton: { borderRadius: 10, backgroundColor: colors.budgetButton, paddingHorizontal: 14 },
  buttonText: { color: colors.primary, fontSize: 15, fontWeight: "700" },
  lightText: { color: colors.onPrimary },
  glyph: { fontSize: 28 },
  dim: { opacity: 0.5 },
  grow: { flex: 1 },
  trailing: { flexShrink: 1, alignItems: "flex-end" },
  between: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  card: {
    backgroundColor: colors.paper,
    borderRadius: 16,
    overflow: "hidden",
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: colors.outline,
  },
  row: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.outline,
  },
  rowName: { color: colors.text, fontSize: 16, fontWeight: "600" },
  caption: { color: colors.secondary, fontSize: 13, marginTop: 3 },
  amount: { color: colors.text, fontSize: 18, fontWeight: "700", fontVariant: ["tabular-nums"] },
  negative: { color: colors.error },
  chevron: { color: colors.secondary, fontSize: 22 },
  hero: { backgroundColor: colors.budgetSurface, borderRadius: 18, padding: 20, gap: 12 },
  deficit: { backgroundColor: colors.budgetDeficit },
  heroLabel: { color: colors.onBudgetMuted, fontSize: 14, fontWeight: "600" },
  heroAmount: {
    color: colors.onPrimary,
    fontSize: 38,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  heroFoot: {
    flexDirection: "row",
    flexWrap: "wrap",
    columnGap: 28,
    rowGap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.budgetDivider,
    paddingTop: 12,
  },
  heroValue: { color: colors.onPrimary, fontSize: 16, fontWeight: "600", marginTop: 2 },
  segments: {
    flexDirection: "row",
    flexWrap: "wrap",
    backgroundColor: colors.paper,
    borderWidth: 1,
    borderColor: colors.outline,
    borderRadius: 12,
    padding: 3,
    gap: 2,
  },
  segment: {
    flexGrow: 1,
    borderRadius: 9,
    minHeight: 48,
    paddingHorizontal: 6,
    alignItems: "center",
    justifyContent: "center",
  },
  selected: { backgroundColor: colors.budgetSurface },
});
