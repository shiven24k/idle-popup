#!/usr/bin/env node
/**
 * Build the image collection for Idle Popup and publish it to Cloudflare R2.
 *
 *   pnpm content:sync --dir ./content/inbox
 *   pnpm content:sync --pinterest-pin https://www.pinterest.com/pin/123456/
 *   pnpm content:sync --pinterest-board https://www.pinterest.com/you/calm/
 *   pnpm content:sync --local-out ./content-preview   # no bucket, for testing
 *
 * Only run this yourself when you want new pictures. The app only ever reads
 * manifest.json + images from the bucket.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client,
} from "@aws-sdk/client-s3";

try {
  process.loadEnvFile?.(".env");
} catch {
  /* .env is optional */
}

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
const MAX_BYTES = 15 * 1024 * 1024;
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif", ".svg"]);
const MIME_BY_EXT = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".webp": "image/webp", ".gif": "image/gif", ".avif": "image/avif", ".svg": "image/svg+xml",
};
const EXT_BY_MIME = {
  "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp",
  "image/gif": ".gif", "image/avif": ".avif", "image/svg+xml": ".svg",
};

/* ------------------------------------------------------------------- args */

function usage() {
  console.log(`Idle Popup content sync

Usage
  pnpm content:sync [options]

Options
  --dir <path>                add every image in a folder (repeatable)
  --pinterest-pin <url|id>    add one Pinterest pin (repeatable)
  --pinterest-board <url|id>  add pins from a board via the Pinterest API (repeatable)
  --limit <n>                 max pins per board (default 50)
  --local-out <dir>           write to a folder instead of R2 (testing)
  --dry-run                   show what would be added, write nothing
  --prune                     delete bucket images no longer in the manifest
  -h, --help                  this text

Environment (see .env.example)
  R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
  R2_PUBLIC_BASE_URL        used only to print the config hint
  PINTEREST_ACCESS_TOKEN    needed for --pinterest-board
`);
}

function parseArgs(argv) {
  const args = {
    dirs: [], pins: [], boards: [],
    limit: 50, localOut: null, dryRun: false, prune: false, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const next = argv[++i];
      if (!next || next.startsWith("--")) throw new Error(`${flag} needs a value`);
      return next;
    };
    if (flag === "--dir") args.dirs.push(value());
    else if (flag === "--pinterest-pin") args.pins.push(value());
    else if (flag === "--pinterest-board") args.boards.push(value());
    else if (flag === "--limit") args.limit = Math.max(1, Number(value()) || 50);
    else if (flag === "--local-out") args.localOut = value();
    else if (flag === "--dry-run") args.dryRun = true;
    else if (flag === "--prune") args.prune = true;
    else if (flag === "-h" || flag === "--help") args.help = true;
    else throw new Error(`unknown option: ${flag}`);
  }
  return args;
}

/* ---------------------------------------------------------------- helpers */

async function fetchChecked(url, { timeout = 30000, accept = "image/*,*/*" } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "user-agent": UA, accept },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

function magicMime(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.subarray(0, 4).toString("ascii") === "GIF8") return "image/gif";
  if (buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (buf.subarray(4, 8).toString("ascii") === "ftyp") return "image/avif";
  const head = buf.subarray(0, 512).toString("utf8").trimStart().toLowerCase();
  if (head.startsWith("<svg") || head.startsWith("<?xml")) return "image/svg+xml";
  return null;
}

async function download(url) {
  const res = await fetchChecked(url);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0) throw new Error("empty download");
  if (bytes.length > MAX_BYTES) throw new Error(`image larger than ${MAX_BYTES / 1024 / 1024} MB`);
  if (!magicMime(bytes)) throw new Error("downloaded file is not an image");
  return bytes;
}

const hashId = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 16);

function decodeEntities(value) {
  return value
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, "/").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function metaContent(html, prop) {
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`, "i"),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return decodeEntities(m[1]);
  }
  return null;
}

/* -------------------------------------------------------------- pinterest */

async function pinterestPin(urlOrId) {
  const id = String(urlOrId).match(/(\d{5,})/)?.[1];
  if (!id) throw new Error(`could not find a pin id in ${urlOrId}`);
  const pageUrl = `https://www.pinterest.com/pin/${id}/`;
  const res = await fetchChecked(pageUrl, { accept: "text/html" });
  const html = await res.text();

  let image = metaContent(html, "og:image") ?? metaContent(html, "twitter:image");
  if (!image) {
    const m = html.match(/"image":"(https:\/\/i\.pinimg\.com\/[^"]+)"/);
    if (m) image = m[1].replace(/\\u002F/g, "/").replace(/\\\//g, "/");
  }
  if (!image) throw new Error(`no image found on ${pageUrl}`);

  // Ask for a 1200 px wide variant rather than /originals/: plenty for a
  // 440 px card and far lighter to download and cache. Fall back to what the
  // page gave us if that variant is missing.
  const medium = image.replace(/\/(?:\d{2,}x\d*|originals)\//, "/1200x/");
  let bytes;
  try {
    bytes = await download(medium);
  } catch {
    bytes = await download(image);
  }
  return {
    bytes,
    source: "pinterest",
    credit: pageUrl,
    externalId: `pin-${id}`,
  };
}

function pinterestApi() {
  const token = process.env.PINTEREST_ACCESS_TOKEN;
  if (!token) {
    throw new Error(
      "PINTEREST_ACCESS_TOKEN is not set. Create an app at https://developers.pinterest.com/ and add the token to .env"
    );
  }
  return async (pathname) => {
    const res = await fetch(`https://api.pinterest.com${pathname}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`Pinterest API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    return res.json();
  };
}

async function resolveBoard(call, arg) {
  if (/^\d+$/.test(arg)) return { id: arg, name: arg };
  const slug = arg.replace(/\/+$/, "").split("/").filter(Boolean).pop()?.toLowerCase();
  let bookmark;
  do {
    const q = new URLSearchParams({ page_size: "100" });
    if (bookmark) q.set("bookmark", bookmark);
    const page = await call(`/v5/boards?${q}`);
    for (const board of page.items ?? []) {
      if (
        board.id === arg ||
        board.name?.toLowerCase() === slug ||
        board.url?.replace(/\/+$/, "").toLowerCase().endsWith(`/${slug}`)
      ) {
        return board;
      }
    }
    bookmark = page.bookmark;
  } while (bookmark);
  throw new Error(`board not found: ${arg} (the API only sees boards of the token's account)`);
}

async function pinterestBoard(arg, limit) {
  const call = pinterestApi();
  const board = await resolveBoard(call, arg);
  const pins = [];
  let bookmark;
  do {
    const q = new URLSearchParams({ page_size: "100" });
    if (bookmark) q.set("bookmark", bookmark);
    const page = await call(`/v5/boards/${board.id}/pins?${q}`);
    pins.push(...(page.items ?? []));
    bookmark = page.bookmark;
  } while (bookmark && pins.length < limit);

  const out = [];
  for (const pin of pins.slice(0, limit)) {
    const images = pin.media?.images ?? {};
    let imageUrl = images["1200x"]?.url ?? images.originals?.url;
    if (!imageUrl) {
      const sizes = Object.values(images).filter((image) => image?.url);
      sizes.sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
      imageUrl = sizes[0]?.url;
    }
    imageUrl ??= pin.media?.source?.url;
    if (!imageUrl) continue;
    try {
      out.push({
        bytes: await download(imageUrl),
        source: "pinterest",
        credit: `https://www.pinterest.com/pin/${pin.id}/`,
        externalId: `pin-${pin.id}`,
      });
    } catch (err) {
      console.warn(`  ! pin ${pin.id}: ${err.message}`);
    }
  }
  console.log(`Pinterest board "${board.name}": ${out.length} image(s)`);
  return out;
}

/* ----------------------------------------------------------------- storage */

async function localStore(root) {
  const imagesDir = path.join(root, "images");
  await fs.mkdir(imagesDir, { recursive: true });
  const manifestPath = path.join(root, "manifest.json");

  return {
    describe: (key) => path.join(root, key),
    async readManifest() {
      try {
        return JSON.parse(await fs.readFile(manifestPath, "utf8"));
      } catch {
        return null;
      }
    },
    async writeManifest(manifest) {
      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    },
    async writeImage(key, bytes) {
      const file = path.join(root, key);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, bytes);
    },
    async listImages() {
      return (await fs.readdir(imagesDir)).map((name) => `images/${name}`);
    },
    async deleteImages(keys) {
      await Promise.all(keys.map((key) => fs.rm(path.join(root, key), { force: true })));
    },
  };
}

function r2Store() {
  const required = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) {
    throw new Error(`missing env vars: ${missing.join(", ")} (copy .env.example to .env)`);
  }
  const bucket = process.env.R2_BUCKET;
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });

  return {
    describe: (key) => `${bucket}/${key}`,
    async readManifest() {
      try {
        const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: "manifest.json" }));
        return JSON.parse(await res.Body.transformToString());
      } catch (err) {
        if (err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404) return null;
        throw err;
      }
    },
    async writeManifest(manifest) {
      await client.send(new PutObjectCommand({
        Bucket: bucket, Key: "manifest.json",
        Body: JSON.stringify(manifest, null, 2),
        ContentType: "application/json",
        CacheControl: "public, max-age=300",
      }));
    },
    async writeImage(key, bytes, contentType) {
      await client.send(new PutObjectCommand({
        Bucket: bucket, Key: key, Body: bytes,
        ContentType: contentType,
        CacheControl: "public, max-age=31536000, immutable",
      }));
    },
    async listImages() {
      const keys = [];
      let token;
      do {
        const page = await client.send(new ListObjectsV2Command({
          Bucket: bucket, Prefix: "images/", ContinuationToken: token,
        }));
        for (const object of page.Contents ?? []) if (object.Key) keys.push(object.Key);
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return keys;
    },
    async deleteImages(keys) {
      for (let i = 0; i < keys.length; i += 1000) {
        await client.send(new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })) },
        }));
      }
    },
  };
}

/* -------------------------------------------------------------------- main */

async function readLocalDir(dir) {
  const files = await fs.readdir(dir, { recursive: true });
  const out = [];
  for (const rel of files) {
    const file = path.resolve(dir, rel);
    const ext = path.extname(file).toLowerCase();
    if (!IMAGE_EXT.has(ext)) continue;
    try {
      const bytes = await fs.readFile(file);
      if (!magicMime(bytes)) {
        console.warn(`  ! skipping ${rel}: not a recognised image`);
        continue;
      }
      out.push({ bytes, source: "local", credit: undefined, externalId: path.basename(file) });
    } catch (err) {
      console.warn(`  ! skipping ${rel}: ${err.message}`);
    }
  }
  console.log(`Folder ${dir}: ${out.length} image(s)`);
  return out;
}

function keyFromUrl(url) {
  if (typeof url !== "string") return null;
  try {
    const parsed = url.startsWith("http") ? new URL(url) : null;
    return (parsed ? parsed.pathname : url).replace(/^\/+/, "");
  } catch {
    return url.replace(/^\/+/, "");
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return usage();

  const hasInput = args.dirs.length || args.pins.length || args.boards.length;
  if (!hasInput) {
    usage();
    throw new Error("nothing to add: pass --dir, --pinterest-pin or --pinterest-board");
  }

  let store = null;
  if (args.localOut) store = await localStore(args.localOut);
  else if (args.dryRun) store = null;
  else store = r2Store();

  const existing = (await store?.readManifest()) ?? { version: 1, images: [] };
  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    images: Array.isArray(existing.images) ? [...existing.images] : [],
  };
  const known = new Set(manifest.images.map((image) => image.id ?? keyFromUrl(image.url)));

  const candidates = [];
  for (const dir of args.dirs) candidates.push(...(await readLocalDir(dir)));
  for (const pin of args.pins) {
    try {
      candidates.push(await pinterestPin(pin));
      console.log(`Pinterest pin ${pin}: ok`);
    } catch (err) {
      console.warn(`  ! pin ${pin}: ${err.message}`);
    }
  }
  for (const board of args.boards) candidates.push(...(await pinterestBoard(board, args.limit)));

  let added = 0;
  let skipped = 0;
  for (const candidate of candidates) {
    const id = hashId(candidate.bytes);
    if (known.has(id) || known.has(candidate.externalId)) {
      skipped++;
      continue;
    }
    const mime = magicMime(candidate.bytes);
    const ext = EXT_BY_MIME[mime] ?? ".jpg";
    const key = `images/${id}${ext}`;

    if (candidate.bytes.length > 3 * 1024 * 1024) {
      console.warn(`  ! ${key} is ${(candidate.bytes.length / 1024 / 1024).toFixed(1)} MB; consider compressing`);
    }

    if (args.dryRun) {
      console.log(`would add ${key} (${(candidate.bytes.length / 1024).toFixed(0)} kB)`);
    } else {
      await store.writeImage(key, candidate.bytes, mime ?? MIME_BY_EXT[ext]);
      console.log(`+ ${store.describe(key)}`);
    }

    manifest.images.push({
      id,
      url: key, // relative to manifest.json; the app resolves it
      bytes: candidate.bytes.length,
      source: candidate.source,
      credit: candidate.credit,
      addedAt: new Date().toISOString(),
    });
    known.add(id);
    added++;
  }

  if (args.prune && store) {
    const referenced = new Set(manifest.images.map((image) => keyFromUrl(image.url)).filter(Boolean));
    const existingKeys = await store.listImages();
    const stale = existingKeys.filter((key) => !referenced.has(key));
    if (stale.length) {
      await store.deleteImages(stale);
      console.log(`Pruned ${stale.length} unreferenced object(s)`);
    }
  }

  if (!args.dryRun) {
    await store.writeManifest(manifest);
    console.log(`\nManifest: ${store.describe("manifest.json")}`);
  }

  console.log(`Added ${added}, skipped ${skipped} duplicate(s), ${manifest.images.length} image(s) total.`);
  const base = process.env.R2_PUBLIC_BASE_URL;
  if (base) {
    console.log(`\nApp config (config.json): "contentSource": "cloud", "remoteBaseUrl": "${base.replace(/\/+$/, "")}"`);
  } else if (!args.localOut) {
    console.log("\nSet R2_PUBLIC_BASE_URL (r2.dev domain or custom domain) to get the config hint.");
  }
  if (args.localOut) {
    console.log(`\nServe it locally for testing:\n  cd ${args.localOut} && python3 -m http.server 8787`);
    console.log(`  remoteBaseUrl: "http://localhost:8787"`);
  }
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exitCode = 1;
});
