// Ships a finished archive to any S3-compatible bucket. Vendor-neutral: the provider (Scaleway today)
// lives only in the S3_* env values, never in this code.
import { createReadStream } from "fs";
import { Upload } from "@aws-sdk/lib-storage";
import { s3 } from "./s3Client";

/** Streams a local archive up and returns the `s3://<bucket>/<key>` URL; multipart handles large homes. */
export async function pushArchive(localPath: string, key: string): Promise<string> {
  const { client, bucket } = s3();
  const upload = new Upload({ client, params: { Bucket: bucket, Key: key, Body: createReadStream(localPath) } });
  await upload.done();
  return `s3://${bucket}/${key}`;
}
