import { rm } from "node:fs/promises";
import path from "node:path";

const workspace = path.resolve(process.cwd());
const target = path.resolve(workspace, ".next");

if (path.dirname(target) !== workspace || path.basename(target) !== ".next") {
  throw new Error(`Refusing to clean unexpected path: ${target}`);
}

await rm(target, { recursive: true, force: true });
