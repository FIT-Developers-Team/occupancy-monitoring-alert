#!/usr/bin/env node
// Buat hash scrypt untuk config/users.json:
//   npm run hash-password -- "PasswordBaru#2026" [salt-opsional]
import { scryptSync, randomBytes } from "crypto";

const password = process.argv[2];
if (!password) {
  console.error('Pakai: npm run hash-password -- "PasswordBaru"');
  process.exit(1);
}
const salt = process.argv[3] || randomBytes(8).toString("hex");
const hash = scryptSync(password, salt, 32).toString("hex");
console.log(JSON.stringify({ salt, scrypt: hash }, null, 2));
console.log("\nTempel nilai salt & scrypt di config/users.json untuk user terkait.");
