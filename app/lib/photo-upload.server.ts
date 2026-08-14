import type { AdminApiContext } from "@shopify/shopify-app-remix/server";

const STAGED_UPLOADS_CREATE = `#graphql
  mutation StagedUpload($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets {
        url
        resourceUrl
        parameters {
          name
          value
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const FILE_CREATE = `#graphql
  mutation ImageFileCreate($files: [FileCreateInput!]!) {
    fileCreate(files: $files) {
      files {
        id
        fileStatus
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

export class PhotoUploadError extends Error {}

/** Shared Shopify Files upload flow (staged upload -> direct POST -> fileCreate) for any image, not tied to a return request. */
async function uploadImageFile(
  admin: AdminApiContext,
  { file, filename, alt }: { file: Blob; filename: string; alt: string },
): Promise<{ shopifyFileId: string }> {
  const stagedResponse = await admin.graphql(STAGED_UPLOADS_CREATE, {
    variables: {
      input: [
        {
          resource: "IMAGE",
          filename,
          mimeType: file.type || "image/jpeg",
          httpMethod: "POST",
        },
      ],
    },
  });
  const stagedJson: any = await stagedResponse.json();
  const stagedErrors = stagedJson?.data?.stagedUploadsCreate?.userErrors;
  if (stagedErrors?.length) {
    throw new PhotoUploadError(stagedErrors.map((e: any) => e.message).join(", "));
  }
  const target = stagedJson?.data?.stagedUploadsCreate?.stagedTargets?.[0];
  if (!target) {
    throw new PhotoUploadError("Could not prepare the upload. Please try again.");
  }

  const uploadForm = new FormData();
  for (const param of target.parameters) {
    uploadForm.append(param.name, param.value);
  }
  uploadForm.append("file", file, filename);

  const uploadResponse = await fetch(target.url, { method: "POST", body: uploadForm });
  if (!uploadResponse.ok) {
    throw new PhotoUploadError("The upload failed. Please try again.");
  }

  const fileCreateResponse = await admin.graphql(FILE_CREATE, {
    variables: {
      files: [{ alt, contentType: "IMAGE", originalSource: target.resourceUrl }],
    },
  });
  const fileCreateJson: any = await fileCreateResponse.json();
  const fileErrors = fileCreateJson?.data?.fileCreate?.userErrors;
  if (fileErrors?.length) {
    throw new PhotoUploadError(fileErrors.map((e: any) => e.message).join(", "));
  }
  const createdFile = fileCreateJson?.data?.fileCreate?.files?.[0];
  if (!createdFile?.id) {
    throw new PhotoUploadError("Could not save the file. Please try again.");
  }

  return { shopifyFileId: createdFile.id };
}

export async function uploadReturnPhoto(
  admin: AdminApiContext,
  { file, filename, orderName }: { file: Blob; filename: string; orderName: string },
): Promise<{ shopifyFileId: string }> {
  return uploadImageFile(admin, {
    file,
    filename: `return-${orderName.replace(/[^a-zA-Z0-9]/g, "")}-${filename}`,
    alt: `Return proof photo for order ${orderName}`,
  });
}

export async function uploadShopLogo(
  admin: AdminApiContext,
  { file, filename }: { file: Blob; filename: string },
): Promise<{ shopifyFileId: string }> {
  return uploadImageFile(admin, {
    file,
    filename: `branding-logo-${filename}`,
    alt: "Shop logo",
  });
}

const IMAGE_FILE_URLS_QUERY = `#graphql
  query ImageFileUrls($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on MediaImage {
        id
        image {
          url
        }
      }
      ... on GenericFile {
        id
        url
      }
    }
  }
`;

/** Files are uploaded as MediaImage (see uploadImageFile's contentType: "IMAGE" above); GenericFile is handled too in case that ever changes. Files can briefly be in a PROCESSING state right after upload, during which the URL isn't available yet. */
export async function getImageFileUrls(
  admin: AdminApiContext,
  fileIds: string[],
): Promise<Record<string, string | null>> {
  if (fileIds.length === 0) return {};
  const response = await admin.graphql(IMAGE_FILE_URLS_QUERY, { variables: { ids: fileIds } });
  const json: any = await response.json();
  const urls: Record<string, string | null> = {};
  for (const node of json?.data?.nodes ?? []) {
    if (node?.id) urls[node.id] = node.image?.url ?? node.url ?? null;
  }
  return urls;
}

// Kept as an alias -- existing call sites reference this name.
export const getReturnPhotoUrls = getImageFileUrls;

/** Shopify Files process asynchronously; poll briefly for the CDN URL to become available right after upload rather than saving a null URL. */
export async function resolveFileUrlWithRetry(
  admin: AdminApiContext,
  fileId: string,
  { attempts = 5, delayMs = 800 }: { attempts?: number; delayMs?: number } = {},
): Promise<string | null> {
  for (let i = 0; i < attempts; i++) {
    const urls = await getImageFileUrls(admin, [fileId]);
    const url = urls[fileId];
    if (url) return url;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return null;
}
