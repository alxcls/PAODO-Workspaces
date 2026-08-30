// Reads backup sets back out of the bucket s3Sink writes to. listSets returns only complete sets —
// a prefix whose backup.json is absent is treated as if it does not exist — so a torn or in-flight
// push is as invisible here as it must be to restore. Object I/O only; set logic lives in setTransfer.
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import type { Readable } from "stream";
import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import type { GetObjectCommandOutput } from "@aws-sdk/client-s3";
import { s3 } from "./s3Client";
import { SET_MANIFEST_MEMBER } from "../../archive/setManifest";

/** The object reads a set verifier needs. Injectable so set-level logic tests without a network. */
export interface ObjectSource {
  /** Prefixes of complete sets under `<instance>/` — those whose backup.json is present. */
  listSets(instance: string): Promise<string[]>;
  getText(key: string): Promise<string>;
  pull(key: string, localPath: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

async function objectExists(key: string): Promise<boolean> {
  const { client, bucket } = s3();
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err) {
    if ((err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return false;
    throw err;
  }
}

async function setPrefixes(instance: string): Promise<string[]> {
  const { client, bucket } = s3();
  const prefixes: string[] = [];
  let token: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: `${instance}/`, Delimiter: "/", ContinuationToken: token }),
    );
    for (const cp of page.CommonPrefixes ?? []) if (cp.Prefix) prefixes.push(cp.Prefix.replace(/\/$/, ""));
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return prefixes;
}

async function getBody(key: string): Promise<NonNullable<GetObjectCommandOutput["Body"]>> {
  const { client, bucket } = s3();
  const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!res.Body) throw new Error(`${key}: object has no body`);
  return res.Body;
}

export function s3Source(): ObjectSource {
  return {
    exists: objectExists,
    async listSets(instance) {
      const complete: string[] = [];
      for (const prefix of await setPrefixes(instance)) {
        if (await objectExists(`${prefix}/${SET_MANIFEST_MEMBER}`)) complete.push(prefix);
      }
      return complete;
    },
    async getText(key) {
      return (await getBody(key)).transformToString();
    },
    async pull(key, localPath) {
      await pipeline((await getBody(key)) as Readable, createWriteStream(localPath));
    },
  };
}
