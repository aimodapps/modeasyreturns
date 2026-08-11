import { Resend } from "resend";
import db from "../db.server";

const resendClient = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const FROM_ADDRESS = process.env.RETURNS_EMAIL_FROM || "returns@example.com";

async function sendAndLog({
  returnRequestId,
  type,
  to,
  subject,
  html,
}: {
  returnRequestId: string;
  type: "RETURN_INITIATED" | "RETURN_APPROVED" | "RETURN_DENIED";
  to: string;
  subject: string;
  html: string;
}) {
  if (!resendClient) {
    await db.adminNotificationLog.create({
      data: {
        returnRequestId,
        type,
        recipientEmail: to,
        status: "SKIPPED",
        errorMessage: "RESEND_API_KEY is not configured -- email was not sent.",
      },
    });
    return;
  }

  try {
    const result = await resendClient.emails.send({ from: FROM_ADDRESS, to, subject, html });
    await db.adminNotificationLog.create({
      data: {
        returnRequestId,
        type,
        recipientEmail: to,
        status: result.error ? "FAILED" : "SENT",
        providerMessageId: result.data?.id ?? null,
        errorMessage: result.error?.message ?? null,
      },
    });
  } catch (error) {
    await db.adminNotificationLog.create({
      data: {
        returnRequestId,
        type,
        recipientEmail: to,
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
      <p>Good news -- your return request for order <strong>${orderName}</strong> has been approved and is being processed.</p>
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
