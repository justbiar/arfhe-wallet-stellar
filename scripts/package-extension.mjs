/**
 * Packages the built extension into the site, so a visitor can actually run the Stellar side.
 *
 * The Chrome Web Store build does not contain any of it: the store version is the EVM wallet,
 * and the bridge, the bank mode and the Stellar account live only in this branch. A visitor
 * who installs from the store and then opens the bridge gets a wallet that cannot answer it.
 * The download is the honest way around that until the Stellar work ships to the store.
 *
 * A zip of `dist/`, loaded through chrome://extensions → Load unpacked. Not a .crx: Chrome
 * refuses to install a crx that is not from the store, so signing one would only produce a
 * file that fails later, in a dialog that reads like the wallet is broken.
 *
 * The `key` in the manifest stays. It fixes the extension id, and that id is what the panel
 * looks for when it decides whether Arfhe Wallet is installed — a build without it gets a
 * different id on every profile and the bridge would never find it.
 *
 *   npm run build:chrome && npm run build:site
 *
 * Run it after the panel build, never before: `build:panel` empties `dist-panel/`, so a zip
 * packaged first disappears and the download link starts answering with the index page.
 * `build:site` chains the two in the right order.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const outDir = path.join(root, "dist-panel", "download");

if (!existsSync(path.join(dist, "manifest.json"))) {
  console.error("dist/manifest.json yok — önce `npm run build:chrome` çalıştırın.");
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(path.join(dist, "manifest.json"), "utf8"));
const name = `arfhe-wallet-${manifest.version}-testnet.zip`;
const target = path.join(outDir, name);

mkdirSync(outDir, { recursive: true });
rmSync(target, { force: true });

// `zip` from the system rather than a dependency: it is on macOS and every CI image, and a
// download this simple does not deserve a node module that can break the build.
execFileSync("zip", ["-qr", target, "."], { cwd: dist });

const bytes = statSync(target).size;
const sha256 = createHash("sha256").update(readFileSync(target)).digest("hex");

// The page reads this instead of hardcoding a filename and a size that go stale silently.
writeFileSync(
  path.join(outDir, "extension.json"),
  JSON.stringify(
    {
      file: `download/${name}`,
      version: manifest.version,
      bytes,
      sha256,
      builtAt: new Date().toISOString(),
      // Which anchor this build talks to. Baked in at build time, so a build handed out
      // before the anchor moved will look for the old one.
      anchor: process.env.VITE_ANCHOR_DOMAIN ?? "localhost:8790",
    },
    null,
    2,
  ) + "\n",
);

console.log(`${name}  ${(bytes / 1024 / 1024).toFixed(1)} MB  sha256 ${sha256.slice(0, 16)}…`);
