import { useState, type ReactNode } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from "react-native";
import { colors, spacing } from "./theme.ts";

export function Label({ children, muted = false }: { children: ReactNode; muted?: boolean }) {
  return <Text style={[styles.text, muted && styles.secondary]}>{children}</Text>;
}

export function Heading({ children }: { children: ReactNode }) {
  return (
    <Text accessibilityRole="header" style={styles.heading}>
      {children}
    </Text>
  );
}

export function Action({
  title,
  onPress,
  disabled = false,
  secondary = false,
  selected = false,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  secondary?: boolean;
  selected?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        secondary && styles.secondaryButton,
        selected && styles.selected,
        (disabled || pressed) && styles.dim,
      ]}
    >
      <Text style={[styles.buttonText, secondary && styles.secondaryButtonText]}>{title}</Text>
    </Pressable>
  );
}

export function TextAction({
  title,
  onPress,
  disabled = false,
  selected = false,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  selected?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.textAction,
        selected && styles.activeAction,
        (disabled || pressed) && styles.dim,
      ]}
    >
      <Text style={[styles.buttonText, styles.secondaryButtonText]}>{title}</Text>
    </Pressable>
  );
}

export function Field({
  label,
  hideLabel = false,
  ...props
}: TextInputProps & { label: string; hideLabel?: boolean }) {
  const [focused, setFocused] = useState(false);
  return (
    <View style={styles.fieldGroup}>
      {!hideLabel && <Text style={styles.fieldLabel}>{label}</Text>}
      <TextInput
        {...props}
        accessibilityLabel={label}
        placeholderTextColor={colors.secondary}
        selectionColor={colors.primary}
        autoCapitalize="none"
        autoCorrect={false}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={[styles.input, focused && styles.focused, props.editable === false && styles.dim]}
      />
    </View>
  );
}

export function Selection({
  label,
  emptyLabel,
  value,
  options,
  onChange,
  onAdd,
  disabled,
}: {
  label: string;
  emptyLabel: string;
  value: string;
  options: ReadonlyArray<{ id: string; name: string }>;
  onChange: (id: string) => void;
  onAdd: () => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.selectionRow}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Select ${label.toLowerCase()}`}
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={() => setOpen(true)}
        style={styles.selectionValue}
      >
        <Text numberOfLines={1} style={styles.selectionText}>
          {options.find((option) => option.id === value)?.name ?? emptyLabel} ▾
        </Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Add ${label.toLowerCase()}`}
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={onAdd}
        style={styles.add}
      >
        <Text style={styles.plus}>+</Text>
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <View style={styles.modalBackground}>
          <View style={styles.modal}>
            <Heading>{label}</Heading>
            <ScrollView keyboardShouldPersistTaps="handled">
              {[{ id: "", name: emptyLabel }, ...options].map((option) => (
                <Pressable
                  key={option.id}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: value === option.id }}
                  onPress={() => {
                    onChange(option.id);
                    setOpen(false);
                  }}
                  style={[styles.option, value === option.id && styles.selected]}
                >
                  <Label>{option.name}</Label>
                </Pressable>
              ))}
            </ScrollView>
            <Action title="Cancel" secondary onPress={() => setOpen(false)} />
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  textAction: {
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: 4,
    borderBottomWidth: 2,
    borderColor: colors.surface,
  },
  activeAction: { borderColor: colors.primary },
  text: { color: colors.text, fontSize: 16, lineHeight: 23 },
  secondary: { color: colors.secondary, fontSize: 14, lineHeight: 21 },
  heading: { color: colors.text, fontSize: 22, fontWeight: "600" },
  button: {
    minHeight: 44,
    paddingHorizontal: spacing.medium,
    paddingVertical: 8,
    borderRadius: 8,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: colors.primary,
    borderWidth: 1,
    borderColor: colors.primary,
  },
  buttonText: { color: colors.onPrimary, fontSize: 16, fontWeight: "600" },
  secondaryButton: { backgroundColor: colors.surface, borderColor: colors.primary },
  secondaryButtonText: { color: colors.primary },
  selected: { backgroundColor: colors.selected },
  dim: { opacity: 0.5 },
  fieldGroup: { gap: 4 },
  fieldLabel: { color: colors.text, fontSize: 14, lineHeight: 20 },
  input: {
    minHeight: 44,
    borderBottomWidth: 1,
    borderColor: colors.secondary,
    paddingHorizontal: 4,
    paddingVertical: 8,
    fontSize: 16,
    color: colors.text,
    backgroundColor: colors.surface,
  },
  focused: { borderColor: colors.primary, borderBottomWidth: 2 },
  selectionRow: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: 1,
    borderColor: colors.outline,
  },
  selectionValue: { flex: 1, minHeight: 44, justifyContent: "center", paddingHorizontal: 8 },
  selectionText: { color: colors.primary, fontSize: 16, textAlign: "right" },
  add: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" },
  plus: { color: colors.primary, fontSize: 26 },
  modalBackground: {
    flex: 1,
    justifyContent: "center",
    padding: 24,
    backgroundColor: colors.scrim,
  },
  modal: {
    backgroundColor: colors.surface,
    padding: 16,
    borderRadius: 12,
    maxHeight: "70%",
    gap: 12,
  },
  option: { minHeight: 48, padding: 12, justifyContent: "center" },
});
