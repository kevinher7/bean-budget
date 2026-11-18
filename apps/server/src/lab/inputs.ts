import type { CreateAccount, MailReviewAction } from "@bean-budget/protocol";
import type { MailIngestionConfig } from "../mail/ingestion.ts";

const sender = "smbc-debit@smbc-card.com";
const subject = "ご利用のお知らせ";
const body = [
  "利用日：2026/11/12 12:34:56",
  "利用先：Example Coffee",
  "利用金額：1,250円",
  "承認番号：123456",
  "",
].join("\r\n");

const mime = [
  `From: ${sender}`,
  "To: example@example.invalid",
  `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
  "Date: Thu, 12 Nov 2026 12:34:56 +0900",
  "Message-ID: <lab-debit@example.invalid>",
  "MIME-Version: 1.0",
  "Content-Type: text/plain; charset=UTF-8",
  "Content-Transfer-Encoding: base64",
  "",
  ...(Buffer.from(body)
    .toString("base64")
    .match(/.{1,76}/g) ?? []),
  "",
].join("\r\n");

const account = {
  id: "lab-jpy",
  operationId: "lab-open-jpy",
  name: "Lab JPY",
  currency: "JPY",
  openingBalance: 10_000,
  date: "2026-11-01",
} satisfies typeof CreateAccount.Type;

const ingestion = {
  connectionId: "lab-gmail",
  cutover: "2026-11-01",
  accounts: { smbc: account.id },
  trustGmailAuthenticationResults: false,
  status: "posted",
} satisfies typeof MailIngestionConfig.Type;

const message = {
  id: "lab-debit",
  metadata: {
    from: sender,
    subject,
    internalDate: String(Date.parse("2026-11-12T12:34:56+09:00")),
  },
  mime,
};

const reviewAction = {
  action: "import",
  operationId: "lab-review-debit",
  message: { connectionId: ingestion.connectionId, messageId: message.id },
} satisfies typeof MailReviewAction.Type;

export const inputs = {
  account,
  ingestion,
  message,
  gmail: { profileHistoryId: "1000", finalHistoryId: "1001" },
  reviewAction,
};
