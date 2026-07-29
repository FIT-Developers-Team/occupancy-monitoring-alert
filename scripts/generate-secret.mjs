import { randomBytes } from "node:crypto";

// 48 random bytes produce a 64-character base64url secret. Output only the
// value so it can be pasted directly into a deployment environment variable.
process.stdout.write(`${randomBytes(48).toString("base64url")}\n`);
