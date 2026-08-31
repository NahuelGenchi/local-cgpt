import { promises as dns } from 'node:dns';
import type { IncomingHttpHeaders } from 'node:http';
import https, { type RequestOptions } from 'node:https';
import { BlockList, isIP } from 'node:net';

export const DEFAULT_REFERENCE_BYTES = 192 * 1024;
export const MAX_REFERENCE_BYTES = 512 * 1024;
export const MAX_REFERENCE_DOWNLOAD_BYTES = 8 * 1024 * 1024;
export const MAX_REFERENCE_SEARCH_BYTES = 64 * 1024;
const GBATEK_DOWNLOAD_BYTES = 4_300_000;
const MAX_REDIRECTS = 4;
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_SEARCH_QUERY_CHARS = 160;
const MAX_SEARCH_MATCHES = 8;
const SEARCH_CONTEXT_BEFORE_CHARS = 1_000;
const SEARCH_CONTEXT_AFTER_CHARS = 2_000;

export interface PublicReference {
  readonly id: string;
  readonly label: string;
  readonly url: string;
  /**
   * Trusted application-owned network ceiling for an unusually large exact resource.
   * The model never controls this value. Normal references use the requested model-output
   * ceiling as their download ceiling, keeping resource use small by default.
   */
  readonly downloadBytes?: number;
}

/**
 * Public engineering references local-cgpt is willing to contact.
 *
 * This is deliberately an exact-URL catalog rather than a host allowlist. A host allowlist
 * would still let a prompt-injected model encode local data into an otherwise-approved URL
 * path/query and leak it through the remote server's request logs. The model therefore never
 * supplies a network destination: it chooses one stable id and trusted app code supplies the
 * exact URL below.
 *
 * Repository files may recommend these ids/URLs, but repository content never expands this
 * authority. Adding a destination or a larger network ceiling requires a reviewed local-cgpt
 * source change.
 */
export const PUBLIC_REFERENCE_CATALOG: readonly PublicReference[] = Object.freeze(
  [
    {
      id: 'gbatek',
      label: 'GBATEK — GBA/NDS technical reference',
      url: 'https://raw.githubusercontent.com/mgba-emu/gbatek/64b5087aa45cd0187b8b239d77e54ee5eb2917d1/index.md',
      downloadBytes: GBATEK_DOWNLOAD_BYTES
    },
    { id: 'ndspy', label: 'ndspy documentation', url: 'https://ndspy.readthedocs.io/en/latest/' },
    { id: 'ndspy-narc', label: 'ndspy NARC API', url: 'https://ndspy.readthedocs.io/en/latest/api/narc.html' },
    { id: 'ekona', label: 'Ekona / SceneGate documentation', url: 'https://scenegate.github.io/Ekona/' },
    { id: 'ekona-cartridge', label: 'Ekona cartridge feature documentation', url: 'https://scenegate.github.io/Ekona/docs/dev/features/cartridge.html' },
    { id: 'ekona-header', label: 'Ekona cartridge header specification', url: 'https://scenegate.github.io/Ekona/docs/specs/cartridge/header.html' },
    { id: 'ndstool', label: 'devkitPro ndstool source', url: 'https://github.com/devkitPro/ndstool' },
    { id: 'dsdecmp', label: 'DSDecmp source', url: 'https://github.com/Barubary/dsdecmp' },
    { id: 'tonc', label: 'TONC GBA programming reference', url: 'https://www.coranac.com/tonc/text/toc.htm' },
    { id: 'pret', label: 'pret organization', url: 'https://github.com/pret' },
    { id: 'pret-pokefirered', label: 'pret pokefirered', url: 'https://github.com/pret/pokefirered' },
    { id: 'pret-pokeemerald', label: 'pret pokeemerald', url: 'https://github.com/pret/pokeemerald' },
    { id: 'tinke', label: 'Tinke archived source', url: 'https://github.com/pleonex/tinke' },
    { id: 'ctrmapv-gen5', label: 'CTRMapV pinned Generation V reference', url: 'https://github.com/ds-pokemon-hacking/CTRMapV/tree/3c2778095867f3007ad48d2c268feb0331d43d70' },
    { id: 'sdsme-gen5', label: 'SDSME pinned Generation V reference', url: 'https://github.com/Skareeg/SDSME/tree/14f0e908a4dae9650ba1a52fd2b75fcd5ea7a011' },
    { id: 'ctrmap-ce-script', label: 'CTRMap Community Edition pinned script reference', url: 'https://github.com/ds-pokemon-hacking/CTRMap-CE/tree/74e2b035ac730f5cf76d588d597dcb43569d4c4b' },
    { id: 'swan-script', label: 'Swan pinned script reference', url: 'https://github.com/ds-pokemon-hacking/swan/tree/4324f73a7659353a21bf4c523905c5d09cf6a066' },
    { id: 'frost-gen5', label: "Frost's Gen 5 Editor pinned reference", url: 'https://github.com/FrostFalcon/FrostsGen5Editor/tree/334344270b82b47c40bdbcfbcad2aac2d003a8b5' },
    { id: 'cheapscript', label: 'CheapScript pinned reference', url: 'https://github.com/PlatinumMaster/CheapScript/tree/83bdb941f3ae1ab487c2e2d36fb7d1314b3e2d5f' },
    { id: 'emudev-index', label: 'EmuDev systems resource index', url: 'https://github.com/emudev-org/discord-resources/blob/main/emudev_resources_systems.md' },
    { id: 'libretro-overview', label: 'Libretro development overview', url: 'https://docs.libretro.com/development/libretro-overview/' },
    { id: 'libretro-cores', label: 'Libretro core development guide', url: 'https://docs.libretro.com/development/cores/developing-cores/' },
    { id: 'libretro-header', label: 'Canonical libretro.h', url: 'https://github.com/libretro/libretro-common/blob/master/include/libretro.h' },
    { id: 'melonds-ds-docs', label: 'melonDS DS libretro documentation', url: 'https://docs.libretro.com/library/melonds_ds/' },
    { id: 'melonds-ds-source', label: 'melonDS DS libretro source', url: 'https://github.com/JesseTG/melonds-ds' },
    { id: 'rustonomicon-ffi', label: 'Rustonomicon FFI', url: 'https://doc.rust-lang.org/nomicon/ffi.html' },
    { id: 'cargo-workspaces', label: 'Cargo workspaces reference', url: 'https://doc.rust-lang.org/cargo/reference/workspaces.html' },
    { id: 'winit-0.30.13', label: 'winit 0.30.13 source docs', url: 'https://docs.rs/crate/winit/0.30.13/source/' },
    { id: 'wgpu-30.0.0', label: 'wgpu 30.0.0 documentation', url: 'https://docs.rs/wgpu/30.0.0/wgpu/' },
    { id: 'learn-wgpu', label: 'Learn Wgpu', url: 'https://sotrh.github.io/learn-wgpu/' },
    { id: 'cpal-0.18.2', label: 'CPAL 0.18.2 documentation', url: 'https://docs.rs/cpal/0.18.2/cpal/' },
    { id: 'egui-0.35.0', label: 'egui 0.35.0 documentation', url: 'https://docs.rs/egui/0.35.0/egui/' },
    { id: 'xdg-basedir', label: 'XDG Base Directory specification', url: 'https://specifications.freedesktop.org/basedir/' },
    { id: 'xdg-filechooser', label: 'XDG FileChooser portal specification', url: 'https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.FileChooser.html' },
    { id: 'linux-input-codes', label: 'Linux kernel input event codes', url: 'https://docs.kernel.org/input/event-codes.html' }
  ].map((entry) => Object.freeze(entry))
);

export interface PublicReferenceResult {
  reference: PublicReference;
  finalUrl: string;
  contentType: string;
  /** Total bytes downloaded from the reviewed resource. */
  bytes: number;
  /** UTF-8 bytes returned to the model after the fixed output cap. */
  returnedBytes: number;
  redirects: number;
  truncated: boolean;
  text: string;
}

export interface PublicReferenceSearchResult {
  reference: PublicReference;
  finalUrl: string;
  contentType: string;
  bytes: number;
  returnedBytes: number;
  redirects: number;
  query: string;
  matches: number;
  moreMatches: boolean;
  text: string;
}

export interface ResolvedReferenceAddress {
  address: string;
  family: 4 | 6;
}

export interface ReferenceHttpResponse {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export interface ReferenceWebDependencies {
  resolve?: (hostname: string) => Promise<ResolvedReferenceAddress[]>;
  request?: (
    target: URL,
    address: ResolvedReferenceAddress,
    maxBytes: number
  ) => Promise<ReferenceHttpResponse>;
}

export class PublicReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublicReferenceError';
  }
}

const blockedIpv4 = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
] as const) {
  blockedIpv4.addSubnet(address, prefix, 'ipv4');
}

const blockedIpv6 = new BlockList();
for (const [address, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001::', 32],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8]
] as const) {
  blockedIpv6.addSubnet(address, prefix, 'ipv6');
}

/** True only for an ordinary globally-routable address we are willing to contact. */
export function isPublicReferenceAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blockedIpv4.check(address, 'ipv4');
  if (family === 6) return !blockedIpv6.check(address, 'ipv6');
  return false;
}

function validatedCatalogUrl(value: string): URL {
  let target: URL;
  try {
    target = new URL(value);
  } catch {
    throw new PublicReferenceError('The reviewed public-reference catalog contains an invalid URL.');
  }
  if (target.protocol !== 'https:') throw new PublicReferenceError('Public references must use HTTPS.');
  if (target.username || target.password) throw new PublicReferenceError('Public references cannot contain URL credentials.');
  if (target.port) throw new PublicReferenceError('Public references cannot use a non-standard port.');
  if (target.search) throw new PublicReferenceError('Public-reference catalog URLs cannot contain query parameters.');
  if (!target.hostname || target.hostname.endsWith('.') || isIP(target.hostname.replace(/^\[|\]$/g, '')) !== 0) {
    throw new PublicReferenceError('Public references must use a reviewed DNS hostname, not an IP literal.');
  }
  return target;
}

const catalogById = new Map<string, PublicReference>();
const catalogUrls = new Set<string>();
for (const entry of PUBLIC_REFERENCE_CATALOG) {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(entry.id)) {
    throw new Error(`Invalid built-in public-reference id: ${entry.id}`);
  }
  if (catalogById.has(entry.id)) throw new Error(`Duplicate built-in public-reference id: ${entry.id}`);
  const normalized = validatedCatalogUrl(entry.url).href;
  if (catalogUrls.has(normalized)) throw new Error(`Duplicate built-in public-reference URL: ${entry.url}`);
  if (
    entry.downloadBytes !== undefined &&
    (!Number.isSafeInteger(entry.downloadBytes) ||
      entry.downloadBytes < DEFAULT_REFERENCE_BYTES ||
      entry.downloadBytes > MAX_REFERENCE_DOWNLOAD_BYTES)
  ) {
    throw new Error(`Invalid built-in public-reference download ceiling for ${entry.id}.`);
  }
  catalogById.set(entry.id, entry);
  catalogUrls.add(normalized);
}

export function listPublicReferences(): readonly PublicReference[] {
  return PUBLIC_REFERENCE_CATALOG;
}

export function publicReferenceById(id: string): PublicReference | null {
  return catalogById.get(id) ?? null;
}

async function resolveReferenceHost(hostname: string): Promise<ResolvedReferenceAddress[]> {
  let addresses: ResolvedReferenceAddress[];
  try {
    const rows = await dns.lookup(hostname, { all: true, verbatim: true });
    addresses = rows.map((row) => ({ address: row.address, family: row.family as 4 | 6 }));
  } catch {
    throw new PublicReferenceError(`The public reference host ${hostname} could not be resolved.`);
  }
  if (addresses.length === 0) throw new PublicReferenceError(`The public reference host ${hostname} resolved to no address.`);
  if (addresses.some((row) => !isPublicReferenceAddress(row.address))) {
    throw new PublicReferenceError(`The public reference host ${hostname} resolved to a non-public address.`);
  }
  return addresses;
}

function firstHeader(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

/**
 * Request options are exported for regression tests: the connection host is the already-
 * validated IP, while Host/SNI remain the reviewed DNS name. That prevents a second unchecked
 * DNS lookup between SSRF policy and connect and does not disable normal TLS hostname checks.
 */
export function pinnedReferenceRequestOptions(target: URL, address: ResolvedReferenceAddress): RequestOptions {
  return {
    protocol: 'https:',
    hostname: address.address,
    family: address.family,
    port: 443,
    servername: target.hostname,
    method: 'GET',
    path: `${target.pathname}${target.search}`,
    agent: false,
    rejectUnauthorized: true,
    headers: {
      Host: target.hostname,
      Accept: 'text/plain, text/markdown, text/html, application/json, application/xml, text/xml, application/xhtml+xml;q=0.9',
      'Accept-Encoding': 'identity',
      'User-Agent': 'local-cgpt-public-reference'
    }
  };
}

async function requestPinnedReference(
  target: URL,
  address: ResolvedReferenceAddress,
  maxBytes: number
): Promise<ReferenceHttpResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finishReject = (error: Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    };
    const req = https.request(pinnedReferenceRequestOptions(target, address), (response) => {
      const lengthText = firstHeader(response.headers['content-length']);
      const declaredLength = lengthText ? Number(lengthText) : null;
      if (declaredLength !== null && (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > maxBytes)) {
        response.destroy();
        finishReject(new PublicReferenceError(`The public reference response exceeds the ${maxBytes}-byte download limit.`));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on('data', (chunk: Buffer) => {
        if (settled) return;
        bytes += chunk.length;
        if (bytes > maxBytes) {
          response.destroy();
          finishReject(new PublicReferenceError(`The public reference response exceeds the ${maxBytes}-byte download limit.`));
          return;
        }
        chunks.push(chunk);
      });
      response.once('aborted', () => finishReject(new PublicReferenceError('The public reference response ended unexpectedly.')));
      response.once('error', () => finishReject(new PublicReferenceError('The public reference response failed while reading.')));
      response.once('end', () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve({ statusCode: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) });
      });
    });
    timer = setTimeout(() => {
      req.destroy();
      finishReject(new PublicReferenceError('The public reference request timed out.'));
    }, REQUEST_TIMEOUT_MS);
    req.once('error', () => finishReject(new PublicReferenceError('The public reference request could not be completed.')));
    req.end();
  });
}

function redirectTarget(current: URL, location: string): URL {
  let next: URL;
  try {
    next = new URL(location, current);
  } catch {
    throw new PublicReferenceError('The public reference returned an invalid redirect.');
  }
  if (next.protocol !== 'https:' || next.username || next.password || next.port) {
    throw new PublicReferenceError('The public reference attempted an unsafe redirect.');
  }
  if (next.hostname !== current.hostname) {
    throw new PublicReferenceError('The public reference attempted to redirect outside its reviewed host.');
  }
  if (next.search) {
    throw new PublicReferenceError('The public reference attempted to add query parameters during redirect.');
  }
  if (isIP(next.hostname.replace(/^\[|\]$/g, '')) !== 0) {
    throw new PublicReferenceError('The public reference attempted to redirect to an IP literal.');
  }
  return next;
}

const ALLOWED_CONTENT_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/x-markdown',
  'text/html',
  'application/json',
  'application/xml',
  'text/xml',
  'application/xhtml+xml'
]);

function decodeText(body: Buffer, contentTypeHeader: string): { contentType: string; text: string } {
  const [rawType = '', ...parameters] = contentTypeHeader.split(';');
  const contentType = rawType.trim().toLowerCase();
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    throw new PublicReferenceError(`Unsupported public reference content type: ${contentType || 'missing'}.`);
  }
  let charset = 'utf-8';
  for (const parameter of parameters) {
    const match = /^\s*charset\s*=\s*"?([^";\s]+)"?\s*$/i.exec(parameter);
    if (match) charset = match[1]!.toLowerCase();
  }
  const decoder =
    charset === 'utf-8' || charset === 'utf8' || charset === 'us-ascii'
      ? new TextDecoder('utf-8')
      : charset === 'iso-8859-1' || charset === 'latin1' || charset === 'windows-1252'
        ? new TextDecoder('windows-1252')
        : null;
  if (!decoder) throw new PublicReferenceError(`Unsupported public reference charset: ${charset}.`);
  const text = decoder.decode(body);
  if (text.includes('\u0000')) throw new PublicReferenceError('The public reference contained binary NUL data.');
  return { contentType, text };
}

interface DecodedPublicReference {
  reference: PublicReference;
  finalUrl: string;
  contentType: string;
  bytes: number;
  redirects: number;
  text: string;
}

async function fetchDecodedPublicReference(
  reference: PublicReference,
  downloadBytes: number,
  dependencies: ReferenceWebDependencies
): Promise<DecodedPublicReference> {
  if (!Number.isSafeInteger(downloadBytes) || downloadBytes < 1024 || downloadBytes > MAX_REFERENCE_DOWNLOAD_BYTES) {
    throw new PublicReferenceError(`Public reference download limit must be between 1024 and ${MAX_REFERENCE_DOWNLOAD_BYTES}.`);
  }

  const resolveHost = dependencies.resolve ?? resolveReferenceHost;
  const request = dependencies.request ?? requestPinnedReference;
  let target = validatedCatalogUrl(reference.url);

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const addresses = await resolveHost(target.hostname);
    if (addresses.length === 0 || addresses.some((row) => !isPublicReferenceAddress(row.address))) {
      throw new PublicReferenceError(`The public reference host ${target.hostname} did not resolve exclusively to public addresses.`);
    }
    const response = await request(target, addresses[0]!, downloadBytes);
    if (response.body.length > downloadBytes) {
      throw new PublicReferenceError(`The public reference response exceeds the ${downloadBytes}-byte download limit.`);
    }

    if (response.statusCode >= 300 && response.statusCode < 400) {
      const location = firstHeader(response.headers.location);
      if (!location) throw new PublicReferenceError('The public reference returned a redirect without a location.');
      if (redirects === MAX_REDIRECTS) throw new PublicReferenceError('The public reference exceeded the redirect limit.');
      target = redirectTarget(target, location);
      continue;
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new PublicReferenceError(`The public reference returned HTTP ${response.statusCode}.`);
    }

    const encoding = firstHeader(response.headers['content-encoding']).trim().toLowerCase();
    if (encoding && encoding !== 'identity') {
      throw new PublicReferenceError(`Unsupported public reference content encoding: ${encoding}.`);
    }
    const decoded = decodeText(response.body, firstHeader(response.headers['content-type']));
    return {
      reference,
      finalUrl: target.href,
      contentType: decoded.contentType,
      bytes: response.body.length,
      redirects,
      text: decoded.text
    };
  }
  throw new PublicReferenceError('The public reference exceeded the redirect limit.');
}

function truncateUtf8(text: string, maxBytes: number): { text: string; bytes: number; truncated: boolean } {
  const encoded = Buffer.from(text, 'utf8');
  if (encoded.length <= maxBytes) return { text, bytes: encoded.length, truncated: false };

  let end = maxBytes;
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end--;
  const bounded = encoded.subarray(0, end);
  return { text: bounded.toString('utf8'), bytes: bounded.length, truncated: true };
}

function referenceFor(id: string): PublicReference {
  const reference = publicReferenceById(id);
  if (!reference) throw new PublicReferenceError('Unknown public reference id. Use reference_web action=list first.');
  return reference;
}

/** Fetch one exact application-reviewed public engineering reference and return bounded text. */
export async function readPublicReference(
  id: string,
  maxBytes = DEFAULT_REFERENCE_BYTES,
  dependencies: ReferenceWebDependencies = {}
): Promise<PublicReferenceResult> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > MAX_REFERENCE_BYTES) {
    throw new PublicReferenceError(`Public reference maxBytes must be between 1024 and ${MAX_REFERENCE_BYTES}.`);
  }
  const reference = referenceFor(id);
  const downloadBytes = Math.max(maxBytes, reference.downloadBytes ?? maxBytes);
  const fetched = await fetchDecodedPublicReference(reference, downloadBytes, dependencies);
  const bounded = truncateUtf8(fetched.text, maxBytes);
  return {
    reference,
    finalUrl: fetched.finalUrl,
    contentType: fetched.contentType,
    bytes: fetched.bytes,
    returnedBytes: bounded.bytes,
    redirects: fetched.redirects,
    truncated: bounded.truncated,
    text: bounded.text
  };
}

/**
 * Search one reviewed resource locally after its fixed network request has completed.
 * The query is never placed in DNS, URL, headers, request body, redirect state, or the
 * application-owned download ceiling, so it cannot become a remote exfiltration parameter.
 */
export async function searchPublicReference(
  id: string,
  query: string,
  dependencies: ReferenceWebDependencies = {}
): Promise<PublicReferenceSearchResult> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery || normalizedQuery.length > MAX_SEARCH_QUERY_CHARS) {
    throw new PublicReferenceError(`Public reference search query must contain 1-${MAX_SEARCH_QUERY_CHARS} characters.`);
  }

  const reference = referenceFor(id);
  const downloadBytes = reference.downloadBytes ?? DEFAULT_REFERENCE_BYTES;
  const fetched = await fetchDecodedPublicReference(reference, downloadBytes, dependencies);
  const haystack = fetched.text.toLowerCase();
  const needle = normalizedQuery.toLowerCase();
  const snippets: string[] = [];
  let from = 0;

  while (snippets.length < MAX_SEARCH_MATCHES) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) break;
    const start = Math.max(0, index - SEARCH_CONTEXT_BEFORE_CHARS);
    const end = Math.min(fetched.text.length, index + normalizedQuery.length + SEARCH_CONTEXT_AFTER_CHARS);
    snippets.push(`--- match ${snippets.length + 1} at character ${index} ---\n${fetched.text.slice(start, end)}`);
    from = index + Math.max(needle.length, 1);
  }

  const moreMatches = snippets.length === MAX_SEARCH_MATCHES && haystack.indexOf(needle, from) >= 0;
  const rendered =
    snippets.length > 0
      ? snippets.join('\n\n')
      : `No case-insensitive exact-text matches for ${JSON.stringify(normalizedQuery)}.`;
  const bounded = truncateUtf8(rendered, MAX_REFERENCE_SEARCH_BYTES);

  return {
    reference,
    finalUrl: fetched.finalUrl,
    contentType: fetched.contentType,
    bytes: fetched.bytes,
    returnedBytes: bounded.bytes,
    redirects: fetched.redirects,
    query: normalizedQuery,
    matches: snippets.length,
    moreMatches,
    text: bounded.text
  };
}
