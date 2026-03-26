import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from './env.js';

export const s3 = new S3Client({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY,
    secretAccessKey: env.S3_SECRET_KEY,
  },
  forcePathStyle: true,
});

export async function uploadFile(
  key: string,
  body: Buffer | ReadableStream,
  contentType: string,
  bucket?: string
) {
  return s3.send(
    new PutObjectCommand({
      Bucket: bucket ?? env.S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );
}

export async function downloadFile(key: string, bucket?: string) {
  return s3.send(
    new GetObjectCommand({
      Bucket: bucket ?? env.S3_BUCKET,
      Key: key,
    })
  );
}

export async function deleteFile(key: string, bucket?: string) {
  return s3.send(
    new DeleteObjectCommand({
      Bucket: bucket ?? env.S3_BUCKET,
      Key: key,
    })
  );
}

function sanitizeFilename(filename: string): string {
  return filename.replace(/["\r\n;]/g, '_');
}

export async function getPresignedUrl(
  key: string,
  expiresIn = 3600,
  opts?: { bucket?: string; filename?: string }
): Promise<string> {
  const safeFilename = opts?.filename ? sanitizeFilename(opts.filename) : undefined;
  return getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: opts?.bucket ?? env.S3_BUCKET,
      Key: key,
      ...(safeFilename
        ? { ResponseContentDisposition: `attachment; filename="${safeFilename}"` }
        : {}),
    }),
    { expiresIn }
  );
}

export async function checkMinioHealth(): Promise<{
  status: 'connected' | 'disconnected';
  bucket: string;
}> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: env.S3_BUCKET }));
    return { status: 'connected', bucket: env.S3_BUCKET };
  } catch {
    return { status: 'disconnected', bucket: env.S3_BUCKET };
  }
}

export async function createMultipartUpload(
  key: string,
  contentType: string,
  bucket?: string
): Promise<string> {
  const response = await s3.send(
    new CreateMultipartUploadCommand({
      Bucket: bucket ?? env.S3_BUCKET,
      Key: key,
      ContentType: contentType,
    })
  );
  if (!response.UploadId) {
    throw new Error('Failed to initiate multipart upload: no UploadId returned');
  }
  return response.UploadId;
}

export async function uploadPart(
  key: string,
  uploadId: string,
  partNumber: number,
  body: Uint8Array,
  bucket?: string
): Promise<string> {
  const response = await s3.send(
    new UploadPartCommand({
      Bucket: bucket ?? env.S3_BUCKET,
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber,
      Body: body,
      ContentLength: body.byteLength,
    })
  );
  if (!response.ETag) {
    throw new Error(`No ETag returned for part ${partNumber}`);
  }
  return response.ETag;
}

export async function completeMultipartUpload(
  key: string,
  uploadId: string,
  parts: ReadonlyArray<{ partNumber: number; etag: string }>,
  bucket?: string
): Promise<void> {
  await s3.send(
    new CompleteMultipartUploadCommand({
      Bucket: bucket ?? env.S3_BUCKET,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: {
        Parts: [...parts]
          .sort((a, b) => a.partNumber - b.partNumber)
          .map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
      },
    })
  );
}

export async function abortMultipartUpload(
  key: string,
  uploadId: string,
  bucket?: string
): Promise<void> {
  await s3.send(
    new AbortMultipartUploadCommand({
      Bucket: bucket ?? env.S3_BUCKET,
      Key: key,
      UploadId: uploadId,
    })
  );
}

export async function listParts(
  key: string,
  uploadId: string,
  bucket?: string
): Promise<Array<{ partNumber: number; etag: string; size: number }>> {
  const allParts: Array<{ partNumber: number; etag: string; size: number }> = [];
  let partNumberMarker: string | undefined;

  while (true) {
    const response = await s3.send(
      new ListPartsCommand({
        Bucket: bucket ?? env.S3_BUCKET,
        Key: key,
        UploadId: uploadId,
        PartNumberMarker: partNumberMarker,
      })
    );

    for (const part of response.Parts ?? []) {
      if (part.PartNumber != null && part.ETag) {
        allParts.push({
          partNumber: part.PartNumber,
          etag: part.ETag,
          size: part.Size ?? 0,
        });
      }
    }

    if (!response.IsTruncated) break;
    partNumberMarker =
      response.NextPartNumberMarker != null ? String(response.NextPartNumberMarker) : undefined;
  }

  return allParts;
}
