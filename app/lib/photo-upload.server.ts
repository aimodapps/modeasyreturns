import type { AdminApiContext } from "@shopify/shopify-app-remix/server";

const STAGED_UPLOADS_CREATE = `#graphql
  mutation ReturnPhotoStagedUpload($input: [StagedUploadInput!]!) {
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
  mutation ReturnPhotoFileCreate($files: [FileCreateInput!]!) {
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

export async function uploadReturnPhoto(
  admin: AdminApiContext,
  { file, filename, orderName }: { file: Blob; filename: string; orderName: string },
): Promise<{ shopifyFileId: string }> {
  const stagedResponse = await admin.graphql(STAGED_UPLOADS_CREATE, {
    variables: {
      input: [
        {
          resource: "IMAGE",
          filename: `return-${orderName.replace(/[^a-zA-Z0-9]/g, "")}-${filename}`,
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
    throw new PhotoUploadError("Could not prepare the photo upload. Please try again.");
  }

  const uploadForm = new FormData();
  for (const param of target.parameters) {
    uploadForm.append(param.name, param.value);
  }
  uploadForm.append("file", file, filename);

  const uploadResponse = await fetch(target.url, { method: "POST", body: uploadForm });
  if (!uploadResponse.ok) {
    throw new PhotoUploadError("The photo upload failed. Please try again.");
  }

  const fileCreateResponse = await admin.graphql(FILE_CREATE, {
    variables: {
      files: [
        {
          alt: `Return proof photo for order ${orderName}`,
          contentType: "IMAGE",
          originalSource: target.resourceUrl,
        },
      ],
    },
  });
  const fileCreateJson: any = await fileCreateResponse.json();
  const fileErrors = fileCreateJson?.data?.fileCreate?.userErrors;
  if (fileErrors?.length) {
    throw new PhotoUploadError(fileErrors.map((e: any) => e.message).join(", "));
  }
  const createdFile = fileCreateJson?.data?.fileCreate?.files?.[0];
  if (!createdFile?.id) {
    throw new PhotoUploadError("Could not save the photo. Please try again.");
  }

  return { shopifyFileId: createdFile.id };
}

const RETURN_PHOTO_URLS_QUERY = `#graphql
  query ReturnPhotoUrls($ids: [ID!]!) {
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

/** Photos are uploaded as MediaImage (see uploadReturnPhoto's contentType: "IMAGE" above); GenericFile is handled too in case that ever changes. Files can briefly be in a PROCESSING state right after upload, during which the URL isn't available yet. */
export async function getReturnPhotoUrls(
  admin: AdminApiContext,
  fileIds: string[],
): Promise<Record<string, string | null>> {
  if (fileIds.length === 0) return {};
  const response = await admin.graphql(RETURN_PHOTO_URLS_QUERY, { variables: { ids: fileIds } });
  const json: any = await response.json();
  const urls: Record<string, string | null> = {};
  for (const node of json?.data?.nodes ?? []) {
    if (node?.id) urls[node.id] = node.image?.url ?? node.url ?? null;
  }
  return urls;
}
