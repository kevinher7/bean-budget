import { Schema } from "effect";

// JPY has scale 0.
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
