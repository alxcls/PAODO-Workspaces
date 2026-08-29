// Ships a finished archive to any S3-compatible bucket. Vendor-neutral: the provider (Scaleway today)
// lives only in the S3_* env values, never in this code.
import { createReadStream } from "fs";
import { S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`S3 not configured: ${name} is unset.`);
  return value;
}

let cached: { client: S3Client; bucket: string } | undefined;
function s3(): { client: S3Client; bucket: string } {
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

/** Streams a local archive up and returns the `s3://<bucket>/<key>` URL; multipart handles large homes. */
export async function pushArchive(localPath: string, key: string): Promise<string> {
  const { client, bucket } = s3();
  const upload = new Upload({ client, params: { Bucket: bucket, Key: key, Body: createReadStream(localPath) } });
  await upload.done();
  return `s3://${bucket}/${key}`;
}
