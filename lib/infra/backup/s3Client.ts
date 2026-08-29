// The one S3-compatible client the write and read sides share. Vendor-neutral: everything specific
// to the provider (Scaleway today) lives only in the S3_* env values, never in this code.
import { S3Client } from "@aws-sdk/client-s3";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`S3 not configured: ${name} is unset.`);
  return value;
}

let cached: { client: S3Client; bucket: string } | undefined;

/** Lazily builds and caches the client, so importing this never fails a command that will not push. */
export function s3(): { client: S3Client; bucket: string } {
  cached ??= {
    bucket: required("S3_BUCKET"),
    client: new S3Client({
      endpoint: required("S3_ENDPOINT"),
      region: required("S3_REGION"),
      credentials: {
        accessKeyId: required("S3_ACCESS_KEY_ID"),
        secretAccessKey: required("S3_SECRET_ACCESS_KEY"),
      },
      forcePathStyle: true,
    }),
  };
  return cached;
}
