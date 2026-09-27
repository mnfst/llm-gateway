import { isPublicRoutableHost } from '@better-auth/core/utils/host';
import type { ClientMetadataResourceFetch } from '@better-auth/oauth-provider';
import type { LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import type { IncomingHttpHeaders } from 'node:http';
import { request, type RequestOptions } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { Readable } from 'node:stream';
import { isSelfHosted } from '../common/utils/detect-self-hosted';
import { isCloudMetadataIp } from '../common/utils/url-validation';

const BODY_FORBIDDEN_RESPONSE_STATUSES = new Set([204, 205, 304]);

function responseHeaders(headers: IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) result.append(name, item);
    } else if (value !== undefined) {
      result.append(name, value);
    }
  }
  return result;
}

function selectPinnedAddress(addresses: LookupAddress[], allowPrivate: boolean): LookupAddress {
  if (addresses.length === 0) {
    throw new TypeError('metadata hostname returned no DNS addresses');
  }
  for (const result of addresses) {
    // Reuse the shared SSRF classifier: it covers AWS/GCP/Azure, Alibaba/OCI,
    // and IPv4-mapped IPv6 forms.
    if (isCloudMetadataIp(result.address)) {
      throw new TypeError('metadata hostname must not resolve to a cloud metadata address');
    }
    if (!allowPrivate && !isPublicRoutableHost(result.address)) {
      throw new TypeError('metadata hostname must resolve only to public-routable addresses');
    }
  }
  return addresses.find(({ family }) => family === 4) ?? addresses[0]!;
}

function createPinnedLookup(pinnedAddress: LookupAddress): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [pinnedAddress]);
      return;
    }
    callback(null, pinnedAddress.address, pinnedAddress.family);
  };
}

/**
 * Better Auth's resolve-once CIMD transport for Node.
 *
 * A Client ID Metadata Document is fetched from a URL the client controls, so
 * the request is at the mercy of DNS. Resolve once, reject any answer that is
 * not a public-routable address, then pin that address for the connection so a
 * rebinding between the check and the request cannot redirect it. GET/HEAD
 * only, HTTPS only, redirects never followed.
 */
export const fetchClientMetadataResource: ClientMetadataResourceFetch = async (input, init) => {
  const webRequest = new Request(input, init);
  const url = new URL(webRequest.url);
  if (url.protocol !== 'https:') {
    throw new TypeError('CIMD Node transport requires an HTTPS URL');
  }
  if (webRequest.method !== 'GET' && webRequest.method !== 'HEAD') {
    throw new TypeError('CIMD Node transport supports only GET and HEAD');
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  // A literal address bypasses DNS pinning, and in self-hosted mode the
  // private-host allowance would let a client reach an arbitrary local service.
  // Require a hostname.
  if (isIP(hostname) !== 0) {
    throw new TypeError('CIMD Node transport requires a hostname, not an IP literal');
  }
  // Self-hosted operators control their network, so a CIMD document on a private
  // or loopback host is legitimate there. Cloud installs keep the strict gate.
  const allowPrivate = isSelfHosted();
  let addresses: LookupAddress[] | undefined;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch (error) {
    // A self-hosted operator may use a LAN name its own resolver handles; let
    // the request try to resolve it rather than failing before the fetch.
    if (!allowPrivate) throw error;
  }
  // Address validation always runs, even when the local-mode lookup failed: a
  // cloud-metadata answer must never be reached.
  const pinnedAddress = addresses ? selectPinnedAddress(addresses, allowPrivate) : undefined;
  const headers = Object.fromEntries(webRequest.headers.entries());
  headers.host = url.host;
  const signal = init?.signal ?? (input instanceof Request ? input.signal : webRequest.signal);

  return new Promise((resolve, reject) => {
    const options: RequestOptions & { autoSelectFamily: boolean } = {
      agent: false,
      autoSelectFamily: false,
      headers,
      method: webRequest.method,
      servername: hostname,
      signal,
      ...(pinnedAddress ? { lookup: createPinnedLookup(pinnedAddress) } : {}),
      // A metadata server that accepts the connection then stalls must not wedge
      // the whole authorization flow. Node does not destroy the request on its
      // own when the socket timeout fires.
      timeout: 10_000,
    };
    const clientRequest = request(url, options, (response) => {
      const status = response.statusCode ?? 500;
      // `new Response` throws for a status outside 200-599. A throw inside this
      // callback would escape the promise and could crash the process, so reject.
      if (status < 200 || status > 599) {
        // Destroy rather than resume: a server that streams forever would keep
        // the socket open after the promise rejected.
        response.destroy();
        reject(new TypeError(`metadata server returned an invalid HTTP status: ${status}`));
        return;
      }
      const hasNoBody =
        webRequest.method === 'HEAD' || BODY_FORBIDDEN_RESPONSE_STATUSES.has(status);
      // Drain the response when we are discarding it, or a 205 with a body keeps
      // the socket alive until the peer times out.
      if (hasNoBody) response.resume();
      const body = hasNoBody ? null : (Readable.toWeb(response) as unknown as BodyInit);
      try {
        resolve(
          new Response(body, {
            headers: responseHeaders(response.headers),
            status,
            statusText: response.statusMessage,
          }),
        );
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    clientRequest.once('timeout', () =>
      clientRequest.destroy(new Error('CIMD metadata request timed out')),
    );
    // A 101 moves the connection to an upgraded protocol, so the response
    // callback never fires and the promise would never settle.
    clientRequest.once('upgrade', (_response, socket) => {
      socket.destroy();
      reject(new Error('CIMD metadata request returned an unsupported protocol upgrade'));
    });
    clientRequest.once('error', reject);
    clientRequest.end();
  });
};
