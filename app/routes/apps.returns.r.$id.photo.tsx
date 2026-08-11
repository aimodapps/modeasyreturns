import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import {
  redirect,
  unstable_composeUploadHandlers,
  unstable_createMemoryUploadHandler,
  unstable_parseMultipartFormData,
} from "@remix-run/node";
import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { loadReturnRequestOrThrow } from "../lib/wizard.server";
import { uploadReturnPhoto, PhotoUploadError } from "../lib/photo-upload.server";
import { portalStyles as styles, PORTAL_ANIMATION_CSS } from "../lib/portal-styles";

const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) throw new Response("Not found", { status: 404 });
  const returnRequest = await loadReturnRequestOrThrow(params.id!, session.shop);

  if (returnRequest.lineItems.length === 0) {
    throw redirect(`/apps/returns/r/${returnRequest.id}/items`);
  }
  if (returnRequest.lineItems.some((li) => !li.conditionOptionId || li.conditionDenied)) {
    throw redirect(`/apps/returns/r/${returnRequest.id}/condition`);
  }

  return { returnRequest };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.public.appProxy(request);
  if (!admin || !session) throw new Response("Not found", { status: 404 });
  const returnRequest = await loadReturnRequestOrThrow(params.id!, session.shop);

  const uploadHandler = unstable_composeUploadHandlers(
    unstable_createMemoryUploadHandler({ maxPartSize: MAX_PHOTO_BYTES }),
  );

  let formData;
  try {
    formData = await unstable_parseMultipartFormData(request, uploadHandler);
  } catch {
    return { error: "That photo is too large. Please upload a file under 8MB." };
  }

  const file = formData.get("photo");
  const hasExistingPhoto = returnRequest.photos.length > 0;

  if (!(file instanceof File) || file.size === 0) {
    if (hasExistingPhoto) {
      return redirect(`/apps/returns/r/${returnRequest.id}/reason`);
    }
    return { error: "Please choose a photo to upload." };
  }
  if (!file.type.startsWith("image/")) {
    return { error: "Please upload an image file (JPG, PNG, or HEIC)." };
  }

  try {
    const { shopifyFileId } = await uploadReturnPhoto(admin, {
      file,
      filename: file.name || "photo.jpg",
      orderName: returnRequest.orderName,
    });
    await db.photoUpload.create({
      data: {
        returnRequestId: returnRequest.id,
        shopifyFileId,
        originalFilename: file.name || null,
      },
    });
  } catch (error) {
    if (error instanceof PhotoUploadError) {
      return { error: error.message };
    }
    console.error("[apps.returns.photo] unhandled upload error", error);
    return { error: "We couldn't upload that photo. Please try again." };
  }

  return redirect(`/apps/returns/r/${returnRequest.id}/reason`);
};

export default function PhotoStep() {
  const { returnRequest } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const hasPhoto = returnRequest.photos.length > 0;

  return (
    <div style={styles.page}>
      <style>{PORTAL_ANIMATION_CSS}</style>
      <div style={styles.card} className="portal-card">
        <p style={styles.breadcrumb}>Order {returnRequest.orderName}</p>
        <h1 style={styles.heading}>Please share a picture showing the perfume is not used</h1>
        <p style={styles.subheading}>
          A clear photo of the bottle (and fill level, if visible) helps us process your return
          quickly.
        </p>

        {hasPhoto && (
          <p style={{ fontSize: 13, color: "#1a7f37", marginBottom: 16 }}>
            ✓ Photo received ({returnRequest.photos.length}).{" "}
            {returnRequest.photos[0].originalFilename}
          </p>
        )}

        <Form
          method="post"
          action={`/apps/returns/r/${returnRequest.id}/photo`}
          encType="multipart/form-data"
          style={styles.form}
        >
          <label style={styles.label}>
            {hasPhoto ? "Upload a different photo (optional)" : "Photo"}
            <input type="file" name="photo" accept="image/*" required={!hasPhoto} />
          </label>

          <button style={styles.button} type="submit" disabled={isSubmitting}>
            {isSubmitting
              ? "Uploading…"
              : hasPhoto
                ? "Continue (or choose a new photo above to replace it)"
                : "Upload photo & continue"}
          </button>
        </Form>

        {actionData?.error && <p style={styles.error}>{actionData.error}</p>}
      </div>
    </div>
  );
}
