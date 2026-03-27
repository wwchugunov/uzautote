import fs from "fs";
import path from "path";
import { ROOT_DIR } from "../config.js";

export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function toAbsolutePath(targetPath) {
  if (!targetPath) return "";
  return path.isAbsolute(targetPath) ? targetPath : path.resolve(ROOT_DIR, targetPath);
}
