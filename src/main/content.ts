import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

/**
 * Local image deck.
 *
 * The popup is deliberately self-contained: it only shows files that live in
 * the app's `assets/` folder. They are handed to the renderer as plain file://
 * URLs, so a popup reads no image bytes, does no base64 work and never touches
 * the network.
 *
 * This module must stay free of Electron imports so it can be exercised from
 * plain Node.
 */

export interface PopupContent {
  image: string; // file:// URL
}

const IMAGE_EXTENSIONS = new Set([
  ".svg", ".png", ".jpg", ".jpeg", ".jpe", ".jfif", ".webp", ".gif", ".avif", ".bmp", ".ico",
]);

function walk(dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      out.push(full);
    }
  }
}

/** Every usable image under `assets/`, sorted for a stable deck order. */
export function listImages(assetDir: string): string[] {
  const out: string[] = [];
  walk(assetDir, out);
  return out.sort();
}

export interface AssetPicker {
  /** Next image, or null when `assets/` has no usable images. */
  next(): PopupContent | null;
  /** Never hand out this image again (e.g. the renderer could not decode it). */
  skip(imageUrl: string): void;
}

function shuffle<T>(items: T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function createAssetPicker(assetDir: string): AssetPicker {
  // Shuffled bag: every image is shown once per cycle, and the same image never
  // lands twice in a row across cycle boundaries.
  let bag: string[] = [];
  let cycle = new Set<string>();
  let last: string | null = null;
  const failed = new Set<string>();

  return {
    next() {
      const files = listImages(assetDir).filter((file) => !failed.has(file));
      if (files.length === 0) return null;

      const present = new Set(files);
      bag = bag.filter((file) => present.has(file));
      cycle = new Set([...cycle].filter((file) => present.has(file)));

      // Slip images added while the app is running into the current cycle.
      for (const file of files) {
        if (cycle.has(file)) continue;
        cycle.add(file);
        bag.splice(Math.floor(Math.random() * (bag.length + 1)), 0, file);
      }

      if (bag.length === 0) {
        bag = shuffle(files);
        cycle = new Set(files);
        if (bag.length > 1 && bag[0] === last) {
          [bag[0], bag[bag.length - 1]] = [bag[bag.length - 1], bag[0]];
        }
      }

      last = bag.shift() as string;
      return { image: pathToFileURL(last).toString() };
    },

    skip(imageUrl: string) {
      try {
        failed.add(fileURLToPath(imageUrl));
      } catch { /* not a file URL: nothing to remember */ }
    },
  };
}
