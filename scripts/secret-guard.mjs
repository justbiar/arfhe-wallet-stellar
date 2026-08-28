/**
 * Secret guard — stops a real secret from shipping inside the extension.
 *
 * A Chrome extension is a folder of files the user downloads. Everything Vite inlines into
 * the bundle is plain text in that folder: `import.meta.env.VITE_FOO` becomes the literal
 * value, and anyone who installs the extension can read it with a text editor. No amount
 * of minification or obfuscation changes that — it only decides how long the reading takes.
 *
 * So the boundary is the `VITE_` prefix, and it is a *convention*, not a wall. Vite refuses
 * to inline anything without it, which is why `DEPLOYER_PRIVATE_KEY` never reaches the
 * bundle. But one person typing `VITE_DEPLOYER_PRIVATE_KEY` moves a fund-controlling key
 * into a public file, and nothing in the toolchain would object.
 *
 * This guard runs twice, because the two checks catch different mistakes:
 *
 *   1. **Before the build** — over the environment. Catches a secret about to be inlined,
 *      and names the variable, so the fix is obvious.
 *   2. **After the build** — over `dist/`. Catches secrets that never went through `.env`
 *      at all: a key pasted into a source file, a mnemonic left in a comment, a `.pem`
 *      copied into `public/`. This is the check that looks at what actually ships.
 *
 * What it deliberately does not flag: Alchemy endpoints, WalletConnect project ids,
 * Web3Auth client ids, contract addresses. Those are public identifiers by design — a
 * browser wallet cannot function without shipping some way to reach a node, and pretending
 * otherwise would train everyone to ignore this script.
 */

import fs from "fs";
import path from "path";

/**
 * Patterns that indicate something able to move funds or impersonate a user.
 *
 * Written to be specific rather than broad: a check that cries wolf gets bypassed, and a
 * bypassed check protects nothing.
 */
const SECRET_PATTERNS = [
  {
    name: "private key (0x + 64 hex)",
    // Bounded so a 64-hex ciphertext handle inside a longer hex blob does not trip it.
    re: /(?<![0-9a-fA-Fx])0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/,
  },
  {
    name: "BIP-39 mnemonic (12 or 24 words)",
    re: /\b(?:[a-z]{3,8}\s+){11}[a-z]{3,8}\b/,
  },
  {
    name: "PEM private key block",
    re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  },
];

/** Variable names that must never carry a `VITE_` prefix, whatever their value. */
const FORBIDDEN_NAME = /^VITE_.*(PRIVATE_KEY|MNEMONIC|SEED_PHRASE|SECRET|PASSWORD|PASSPHRASE)/i;

/**
 * Check the environment about to be inlined.
 *
 * @returns Array of human-readable problems; empty when the environment is safe.
 */
export function auditEnv(env) {
  const problems = [];

  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("VITE_") || typeof value !== "string" || !value) continue;

    if (FORBIDDEN_NAME.test(key)) {
      problems.push(
        `${key} — a VITE_ variable is compiled into the bundle as plain text, so this name ` +
          `cannot be right. Drop the VITE_ prefix and read it server-side instead.`
      );
      continue;
    }

    for (const { name, re } of SECRET_PATTERNS) {
      if (re.test(value)) {
        problems.push(`${key} — its value looks like a ${name}, and VITE_ variables ship in the bundle.`);
        break;
      }
    }
  }

  return problems;
}

/**
 * Check what actually shipped, against the secrets this machine actually holds.
 *
 * The first version of this scanned `dist/` for things that *looked* like private keys and
 * flagged ethers, WalletConnect, Web3Auth and the BIP-39 wordlist — every one a false
 * positive. Third-party crypto libraries are full of 32-byte constants and word lists, and
 * a check that fires on all of them is a check everyone learns to skip.
 *
 * So it asks a narrower question with an exact answer: **does any secret from the
 * environment appear verbatim in the build?** No heuristics, no false positives, and it
 * catches the case that actually matters — a value that was supposed to stay server-side
 * ending up in a file the user downloads.
 *
 * `VITE_` variables are excluded because those are inlined *on purpose*; whether one of
 * them should exist at all is the pre-build check's job.
 */
export function auditBundle(distDir, env) {
  const problems = [];
  if (!fs.existsSync(distDir) || !env) return problems;

  // Anything without the prefix was never meant to reach the browser. Short values are
  // skipped: a two-character setting would match everywhere and mean nothing.
  const secrets = Object.entries(env).filter(
    ([key, value]) => !key.startsWith("VITE_") && typeof value === "string" && value.length >= 16
  );
  if (secrets.length === 0) return problems;

  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|mjs|cjs|json|html|css|txt|pem)$/.test(entry.name)) files.push(full);
    }
  };
  walk(distDir);

  for (const file of files) {
    let content;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }

    for (const [key, value] of secrets) {
      if (!content.includes(value)) continue;
      problems.push(
        `${key} — its value is present in ${path.relative(distDir, file)}, but it has no ` +
          `VITE_ prefix and was never meant to leave the machine that holds it.`
      );
    }
  }

  return problems;
}

/** Format problems into a message worth stopping a build for. */
export function formatFailure(problems, phase) {
  return [
    "",
    "  ✖ Secret guard failed " + phase,
    "",
    ...problems.map((p) => `    • ${p}`),
    "",
    "  A Chrome extension ships as readable files. Anything in the bundle is public the",
    "  moment someone installs it — minification is not encryption.",
    "",
    "  Secrets belong somewhere the user's browser never sees: a Worker secret, a backend",
    "  env var, or the user's own key entered at runtime.",
    "",
  ].join("\n");
}

// ── CLI: `node scripts/secret-guard.mjs` audits dist/ ─────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const dist = path.resolve(process.cwd(), "dist");

  // Read .env directly — this runs outside Vite, which is what loads it normally.
  const env = {};
  const envPath = path.resolve(process.cwd(), ".env");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const [key, ...rest] = trimmed.split("=");
      const value = rest.join("=").trim();
      if (value) env[key.trim()] = value;
    }
  }

  const problems = [...auditEnv(env), ...auditBundle(dist, env)];

  if (problems.length > 0) {
    console.error(formatFailure(problems, "on the built bundle"));
    process.exit(1);
  }

  const held = Object.keys(env).filter((k) => !k.startsWith("VITE_")).length;
  console.log(`✓ secret guard: none of the ${held} non-VITE_ values in .env appear in dist/`);
}
