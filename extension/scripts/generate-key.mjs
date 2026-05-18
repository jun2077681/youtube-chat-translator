// One-shot RSA 2048 keypair generator for stable Chrome extension ID.
//
// Run once. The PRIVATE key is written to extension-private.pem (gitignored)
// — back it up somewhere safe (1Password etc.). The PUBLIC key (SPKI base64)
// goes into manifest.json's "key" field, and the derived extension ID goes
// into native-host/manifest.json's allowed_origins.
//
// Algorithm (Chrome's deterministic ID):
//   1. SHA-256 of the public-key SubjectPublicKeyInfo DER bytes
//   2. Take the first 16 bytes (32 hex chars)
//   3. Map each hex nibble 0..f → letter a..p
//
// Usage:
//   cd extension
//   node scripts/generate-key.mjs

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
});

const spkiDer = publicKey.export({ type: "spki", format: "der" });
const spkiB64 = spkiDer.toString("base64");

const sha = crypto.createHash("sha256").update(spkiDer).digest();
const hex = sha.subarray(0, 16).toString("hex");
const id = Array.from(hex)
  .map((c) => String.fromCharCode("a".charCodeAt(0) + parseInt(c, 16)))
  .join("");

const pemPriv = privateKey.export({ type: "pkcs8", format: "pem" });
const pemPath = path.resolve("extension-private.pem");
if (fs.existsSync(pemPath)) {
  console.error(`Refusing to overwrite existing ${pemPath}.`);
  console.error("Delete it manually if you really intend to regenerate the key.");
  process.exit(1);
}
fs.writeFileSync(pemPath, pemPriv);
fs.chmodSync(pemPath, 0o600);

console.log("Private key written to:", pemPath);
console.log("  → Move/back this up. NEVER commit. NEVER share.");
console.log("");
console.log("Extension ID (32 chars a-p):");
console.log("  " + id);
console.log("");
console.log("Public key (paste into extension/manifest.json as the \"key\" field):");
console.log("  " + spkiB64);
