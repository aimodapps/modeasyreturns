import nodemailer from "nodemailer";
import db from "../db.server";

// Sends through Google Workspace's Gmail SMTP using a dedicated mailbox +
// App Password (works from any host, unlike Workspace's IP-allowlisted SMTP
// relay service, which wouldn't survive Render's non-static outbound IPs).
const smtpUser = process.env.GMAIL_SMTP_USER;
const smtpAppPassword = process.env.GMAIL_SMTP_APP_PASSWORD;
const FROM_ADDRESS = process.env.RETURNS_EMAIL_FROM || smtpUser || "returns@example.com";

const transporter =
  smtpUser && smtpAppPassword
    ? nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: 465,
        secure: true,
        auth: { user: smtpUser, pass: smtpAppPassword },
      })
    : null;

async function sendAndLog({
  returnRequestId,
  type,
  to,
  subject,
  html,
}: {
  returnRequestId: string;
  type: "RETURN_INITIATED" | "RETURN_APPROVED" | "RETURN_DENIED" | "RETURN_RECEIVED";
  to: string;
  subject: string;
  html: string;
}) {
  if (!transporter) {
    await db.adminNotificationLog.create({
      data: {
        returnRequestId,
        type,
        recipientEmail: to,
        provider: "gmail-smtp",
        status: "SKIPPED",
        errorMessage: "GMAIL_SMTP_USER/GMAIL_SMTP_APP_PASSWORD are not configured -- email was not sent.",
      },
    });
    return;
  }

  try {
    const result = await transporter.sendMail({ from: FROM_ADDRESS, to, subject, html });
    await db.adminNotificationLog.create({
      data: {
        returnRequestId,
        type,
        recipientEmail: to,
        provider: "gmail-smtp",
        status: "SENT",
        providerMessageId: result.messageId ?? null,
      },
    });
  } catch (error) {
    await db.adminNotificationLog.create({
      data: {
        returnRequestId,
        type,
        recipientEmail: to,
        provider: "gmail-smtp",
        status: "FAILED",
        errorMessage: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

export async function sendReturnInitiatedEmail({
  returnRequestId,
  adminEmail,
  orderName,
  customerEmail,
  itemSummary,
  reviewUrl,
}: {
  returnRequestId: string;
  adminEmail: string;
  orderName: string;
  customerEmail: string | null;
  itemSummary: string;
  reviewUrl: string;
}) {
  await sendAndLog({
    returnRequestId,
    type: "RETURN_INITIATED",
    to: adminEmail,
    subject: `New return request -- Order ${orderName}`,
    html: `
      <h2>Return request initiated</h2>
      <p>Order <strong>${orderName}</strong>${customerEmail ? ` (${customerEmail})` : ""} has submitted a return request.</p>
      <p>${itemSummary}</p>
      <p><a href="${reviewUrl}">Review this request</a></p>
    `,
  });
}

export async function sendReturnApprovedEmail({
  returnRequestId,
  customerEmail,
  orderName,
}: {
  returnRequestId: string;
  customerEmail: string;
  orderName: string;
}) {
  await sendAndLog({
    returnRequestId,
    type: "RETURN_APPROVED",
    to: customerEmail,
    subject: `Your return for order ${orderName} has been approved`,
    html: `
      <h2>Your return was approved</h2>
      <p>Good news -- your return request for order <strong>${orderName}</strong> has been approved. Please ship the item(s) back to us; we'll email you again once we've received and inspected them.</p>
    `,
  });
}

export async function sendReturnReceivedEmail({
  returnRequestId,
  customerEmail,
  orderName,
  refundIssuedAmount,
  currencyCode,
  balanceDueAmount,
}: {
  returnRequestId: string;
  customerEmail: string;
  orderName: string;
  refundIssuedAmount: number | null;
  currencyCode: string | null;
  balanceDueAmount: number | null;
}) {
  const parts: string[] = [];
  if (refundIssuedAmount && refundIssuedAmount > 0) {
    parts.push(`<p>We've issued a refund of <strong>${refundIssuedAmount.toFixed(2)} ${currencyCode ?? ""}</strong>.</p>`);
  }
  if (balanceDueAmount && balanceDueAmount > 0) {
    parts.push(`<p>Your exchange has a remaining balance of <strong>${balanceDueAmount.toFixed(2)} ${currencyCode ?? ""}</strong> -- you'll receive a separate invoice email with a payment link shortly.</p>`);
  }
  if (parts.length === 0) {
    parts.push("<p>Your exchange replacement is on its way -- no further payment is needed.</p>");
  }

  await sendAndLog({
    returnRequestId,
    type: "RETURN_RECEIVED",
    to: customerEmail,
    subject: `We've received your return for order ${orderName}`,
    html: `
      <h2>Your return has been received & inspected</h2>
      <p>We've received and inspected the item(s) you returned for order <strong>${orderName}</strong>.</p>
      ${parts.join("")}
    `,
  });
}

export async function sendReturnDeniedEmail({
  returnRequestId,
  customerEmail,
  orderName,
  note,
}: {
  returnRequestId: string;
  customerEmail: string;
  orderName: string;
  note: string | null;
}) {
  await sendAndLog({
    returnRequestId,
    type: "RETURN_DENIED",
    to: customerEmail,
    subject: `An update on your return for order ${orderName}`,
    html: `
      <h2>Your return request wasn't approved</h2>
      <p>We're sorry, but we're unable to approve your return request for order <strong>${orderName}</strong>.</p>
      ${note ? `<p>${note}</p>` : ""}
    `,
  });
}
