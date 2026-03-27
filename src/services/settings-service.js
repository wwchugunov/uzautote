import fs from "fs";
import path from "path";
import { DEFAULT_SETTINGS, SETTINGS_FILE, UPLOADS_DIR } from "../config.js";
import { ensureDir, toAbsolutePath } from "../utils/fs.js";
import { parseSpreadsheetId } from "../utils/spreadsheet.js";

export class SettingsService {
  constructor() {
    this.ensureFile();
  }

  ensureFile() {
    if (!fs.existsSync(SETTINGS_FILE)) {
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(DEFAULT_SETTINGS, null, 2));
    }
  }

  load() {
    this.ensureFile();
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));

    return {
      appAuth: {
        username: parsed.appAuth?.username || DEFAULT_SETTINGS.appAuth.username,
        password: parsed.appAuth?.password || DEFAULT_SETTINGS.appAuth.password,
      },
      paylink: {
        baseUrl: parsed.paylink?.baseUrl || DEFAULT_SETTINGS.paylink.baseUrl,
        login: parsed.paylink?.login || DEFAULT_SETTINGS.paylink.login,
        password: parsed.paylink?.password || DEFAULT_SETTINGS.paylink.password,
      },
      google: {
        spreadsheetUrl: parsed.google?.spreadsheetUrl || DEFAULT_SETTINGS.google.spreadsheetUrl,
        keyFile: parsed.google?.keyFile || DEFAULT_SETTINGS.google.keyFile,
      },
      output: {
        resultDir: parsed.output?.resultDir || DEFAULT_SETTINGS.output.resultDir,
        defaultFileName: parsed.output?.defaultFileName || DEFAULT_SETTINGS.output.defaultFileName,
      },
      browser: {
        headless:
          typeof parsed.browser?.headless === "boolean"
            ? parsed.browser.headless
            : DEFAULT_SETTINGS.browser.headless,
      },
    };
  }

  save(settings) {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  }

  validate(candidate) {
    const nextSettings = {
      appAuth: {
        username: String(candidate.appAuth?.username || "").trim(),
        password: String(candidate.appAuth?.password || "").trim(),
      },
      paylink: {
        baseUrl: String(candidate.paylink?.baseUrl || "").trim(),
        login: String(candidate.paylink?.login || "").trim(),
        password: String(candidate.paylink?.password || "").trim(),
      },
      google: {
        spreadsheetUrl: String(candidate.google?.spreadsheetUrl || "").trim(),
        keyFile: String(candidate.google?.keyFile || "").trim(),
      },
      output: {
        resultDir: String(candidate.output?.resultDir || "").trim(),
        defaultFileName: String(candidate.output?.defaultFileName || "").trim(),
      },
      browser: {
        headless: Boolean(candidate.browser?.headless),
      },
    };

    if (!nextSettings.appAuth.username || !nextSettings.appAuth.password) {
      throw new Error("Для входа в приложение нужны логин и пароль.");
    }

    if (!nextSettings.paylink.baseUrl || !nextSettings.paylink.login || !nextSettings.paylink.password) {
      throw new Error("Заполните URL, логин и пароль Paylink.");
    }

    if (!nextSettings.google.spreadsheetUrl) {
      throw new Error("Укажите полную ссылку на Google Sheets.");
    }

    if (!parseSpreadsheetId(nextSettings.google.spreadsheetUrl)) {
      throw new Error("Не удалось распознать ссылку на Google Sheets.");
    }

    if (!nextSettings.google.keyFile) {
      throw new Error("Укажите путь к key.json или загрузите новый файл.");
    }

    if (!nextSettings.output.resultDir) {
      throw new Error("Укажите папку для результатов.");
    }

    return nextSettings;
  }

  toPublic(settings) {
    return {
      appAuth: {
        username: settings.appAuth.username,
        password: "",
      },
      paylink: {
        baseUrl: settings.paylink.baseUrl,
        login: settings.paylink.login,
        password: settings.paylink.password,
      },
      google: {
        spreadsheetUrl: settings.google.spreadsheetUrl,
        keyFile: settings.google.keyFile,
        keyFileResolved: toAbsolutePath(settings.google.keyFile),
      },
      output: {
        resultDir: settings.output.resultDir,
        resultDirResolved: toAbsolutePath(settings.output.resultDir),
        defaultFileName: settings.output.defaultFileName,
      },
      browser: {
        headless: settings.browser.headless,
      },
    };
  }

  writeUploadedKeyFile(contentBase64, originalName) {
    ensureDir(UPLOADS_DIR);
    const safeName = originalName && originalName.endsWith(".json") ? originalName : "key.json";
    const fileName = `${Date.now()}-${safeName.replace(/[^a-zA-Z0-9._-]+/g, "-")}`;
    const filePath = path.join(UPLOADS_DIR, fileName);
    const fileContent = Buffer.from(contentBase64, "base64").toString("utf8");

    JSON.parse(fileContent);
    fs.writeFileSync(filePath, fileContent);

    return path.relative(path.resolve(SETTINGS_FILE, ".."), filePath);
  }
}
