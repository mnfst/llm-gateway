import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import type { StoredAttemptRecording } from '../../routing/proxy/attempt-recording.types';
import {
  decryptBuffer,
  encryptBuffer,
  getEncryptionSecret,
  hasBinaryEnvelope,
} from './crypto.util';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

// Recordings hold the exact provider-bound request body and the full response,
// so they are encrypted with the same at-rest secret as provider credentials.
// Blobs written before that change are gzip-only; they still start with the
// gzip magic and keep decoding through the legacy path below.
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);

function isGzip(body: Buffer): boolean {
  return body.length >= GZIP_MAGIC.length && body.subarray(0, GZIP_MAGIC.length).equals(GZIP_MAGIC);
}

export async function encodeRequestRecording(payload: StoredAttemptRecording): Promise<Buffer> {
  const compressed = await gzipAsync(Buffer.from(JSON.stringify(payload), 'utf8'));
  return encryptBuffer(compressed, getEncryptionSecret());
}

export async function decodeRequestRecording(body: Buffer): Promise<StoredAttemptRecording> {
  let compressed: Buffer;
  if (hasBinaryEnvelope(body)) {
    compressed = decryptBuffer(body, getEncryptionSecret());
  } else if (isGzip(body)) {
    compressed = body;
  } else {
    throw new Error('Unrecognized request recording blob: not encrypted and not gzip');
  }
  const payload = JSON.parse(
    (await gunzipAsync(compressed)).toString('utf8'),
  ) as StoredAttemptRecording;
  if (
    payload.version !== 1 ||
    typeof payload.wire_format !== 'string' ||
    !payload.wire_format ||
    !payload.request_body ||
    typeof payload.request_body !== 'object' ||
    !('response_body' in payload)
  ) {
    throw new Error('Invalid request recording object');
  }
  return payload;
}
