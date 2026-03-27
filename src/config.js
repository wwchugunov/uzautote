import path from "path";
import dotenv from "dotenv";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
export const ROOT_DIR = path.resolve(path.dirname(__filename), "..");

function normalizeBasePath(value) {
  const raw = String(value || "").trim();
  if (!raw || raw === "/") return "";

  const normalized = raw.startsWith("/") ? raw : `/${raw}`;
  return normalized.replace(/\/+$/, "");
}

export const PORT = Number(process.env.PORT) || 3000;
export const HTML_FILE = path.join(ROOT_DIR, "index.html");
export const SETTINGS_FILE = path.join(ROOT_DIR, "settings.json");
export const RESULTS_DIR = path.join(ROOT_DIR, "results");
export const UPLOADS_DIR = path.join(ROOT_DIR, "uploads");
export const DEBUG_DIR = path.join(ROOT_DIR, "debug");
export const SESSION_COOKIE = "paylink_session";
export const APP_BASE_PATH = normalizeBasePath(process.env.APP_BASE_PATH || process.env.BASE_PATH);
export const SESSION_COOKIE_PATH = normalizeBasePath(process.env.SESSION_COOKIE_PATH) || "/";

export const DEFAULT_SETTINGS = {
  appAuth: {
    username: process.env.APP_USERNAME || "admin",
    password: process.env.APP_PASSWORD || "admin123",
  },
  paylink: {
    baseUrl: process.env.PAYLINK_BASE_URL || "https://inst2.paylink.com.ua/app",
    login: process.env.LOGIN || "",
    password: process.env.PASSWORD || "",
  },
  google: {
    spreadsheetUrl: process.env.SPREADSHEET_URL || "",
    keyFile: process.env.KEY_FILE || "./key.json",
  },
  output: {
    resultDir: process.env.RESULT_DIR || "./results",
    defaultFileName: process.env.OUTPUT_FILE || "",
  },
  browser: {
    headless: process.env.HEADLESS ? process.env.HEADLESS !== "false" : true,
  },
};
