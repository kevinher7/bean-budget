import { FinancialDate, MAX_UNITS, Name } from "@bean-budget/budget";
import { Effect, Schema } from "effect";
import { simpleParser } from "mailparser";

const issuers = {
  yucho: {
    sender: "yuchodebit@jp-bank.japanpost.jp",
    pattern:
      /利用日時\s+(?<date>\d{4}\/\d{2}\/\d{2})\s+(?<time>\d{2}:\d{2}:\d{2})[\s\S]*?利用店舗\s+(?<merchant>[^\n]+)[\s\S]*?利用金額\s+(?<amount>[\d,]+)円[\s\S]*?承認番号\s+(?<approval>\d+)/,
  },
  smbc: {
    sender: "smbc-debit@smbc-card.com",
    pattern:
      /利用日\s*[:：]\s*(?<date>\d{4}\/\d{2}\/\d{2})\s+(?<time>\d{2}:\d{2}:\d{2})[\s\S]*?利用先\s*[:：]\s*(?<merchant>[^\n]+)[\s\S]*?利用金額\s*[:：]\s*(?<amount>[\d,]+)円[\s\S]*?承認番号\s*[:：]\s*(?<approval>\d+)/,
  },
} as const;

export type MailIssuer = keyof typeof issuers;

export const mailSenders = [issuers.yucho.sender, issuers.smbc.sender];
export const mailSubject = "ご利用のお知らせ";

export type ParsedMail = {
  kind: "parsed";
  id: string;
  issuer: MailIssuer;
  merchant: string;
  approval: string;
  date: string;
  time: string;
  amount: number;
  currency: "JPY";
};

export type MailParseResult =
  | ParsedMail
  | { kind: "ignored"; id: string; reason: string }
  | { kind: "malformed"; id: string; reason: string };

function identifyIssuer(from: string | undefined): MailIssuer | undefined {
  const address = from?.trim().toLowerCase();
  if (address === issuers.yucho.sender) return "yucho";
  if (address === issuers.smbc.sender) return "smbc";
  return undefined;
}

export function matchesMailHeaders(metadata: { from?: string; subject?: string }): boolean {
  const address = metadata.from?.match(/<([^<>]+)>\s*$/)?.[1] ?? metadata.from;
  return (
    identifyIssuer(address) !== undefined &&
    (metadata.subject?.includes(mailSubject) === true || metadata.subject?.includes("=?") === true)
  );
}

export function normalizeMerchant(merchant: string): string {
  return merchant.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

export const parseMail = Effect.fn("Mail.parse")(function* (id: string, raw: string) {
  if (
    raw.length > 1_400_000 ||
    !/^[\w-]+={0,2}$/.test(raw) ||
    raw.replace(/=+$/, "").length % 4 === 1
  )
    return { kind: "malformed", id, reason: "Invalid raw message" } satisfies MailParseResult;

  const result = yield* Effect.tryPromise({
    try: () =>
      simpleParser(Buffer.from(raw, "base64url"), { skipTextToHtml: true, skipTextLinks: true }),
    catch: () =>
      ({ kind: "malformed", id, reason: "Invalid MIME message" }) satisfies MailParseResult,
  }).pipe(Effect.result);
  if (result._tag === "Failure") return result.failure;

  const message = result.success;
  const from = message.from?.value;
  const issuer = from?.length === 1 ? identifyIssuer(from[0]?.address) : undefined;
  if (!issuer || !message.subject?.includes(mailSubject))
    return {
      kind: "ignored",
      id,
      reason: "Unsupported sender or subject",
    } satisfies MailParseResult;

  if (!message.text || message.text.length > 16_000)
    return {
      kind: "malformed",
      id,
      reason: "Missing or oversized debit text",
    } satisfies MailParseResult;

  const fields = issuers[issuer].pattern.exec(message.text.normalize("NFKC"))?.groups;
  const date = fields?.date?.replaceAll("/", "-");
  const time = fields?.time;
  const merchant = fields?.merchant?.trim();
  const approval = fields?.approval;
  const amountText = fields?.amount;
  const amount = Number(amountText?.replaceAll(",", ""));
  if (
    !date ||
    !Schema.is(FinancialDate)(date) ||
    !time ||
    !/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(time) ||
    !merchant ||
    !Schema.is(Name)(merchant) ||
    !approval ||
    approval.length > 40 ||
    !amountText ||
    !/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(amountText) ||
    !Number.isSafeInteger(amount) ||
    amount <= 0 ||
    amount > MAX_UNITS
  )
    return {
      kind: "malformed",
      id,
      reason: "Invalid or missing debit fields",
    } satisfies MailParseResult;

  return {
    kind: "parsed",
    id,
    issuer,
    merchant,
    approval,
    date,
    time,
    amount: -amount,
    currency: "JPY",
  } satisfies MailParseResult;
});
