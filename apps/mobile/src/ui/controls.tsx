import { useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, TextInput, View, type TextInputProps } from "react-native";
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

export function Field({ label, ...props }: TextInputProps & { label: string }) {
  const [focused, setFocused] = useState(false);
  return (
    <View style={styles.fieldGroup}>
      <Label>{label}</Label>
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

const styles = StyleSheet.create({
  text: { color: colors.text, fontSize: 16, lineHeight: 23 },
  secondary: { color: colors.secondary, fontSize: 14, lineHeight: 21 },
  heading: { color: colors.text, fontSize: 22, fontWeight: "600" },
  button: {
    minHeight: 48,
    paddingHorizontal: spacing.medium,
    paddingVertical: 12,
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
  fieldGroup: { gap: spacing.small },
  input: {
    minHeight: 50,
    borderWidth: 1,
    borderColor: colors.secondary,
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    color: colors.text,
    backgroundColor: colors.surface,
  },
  focused: { borderColor: colors.primary, borderWidth: 2 },
});
