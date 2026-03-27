import fs from "fs";
import path from "path";
import puppeteer from "puppeteer";
import XLSX from "xlsx";
import { DEBUG_DIR } from "../config.js";
import { delay } from "../utils/common.js";
import { ensureDir, toAbsolutePath } from "../utils/fs.js";

function normalizeFileName(inputValue, fallbackBase) {
  const raw = String(inputValue || "").trim();
  const safeBase = raw || fallbackBase;
  const withoutExt = safeBase.replace(/\.xlsx$/i, "");
  const cleaned = withoutExt.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return `${cleaned || "result"}.xlsx`;
}

export class PaylinkService {
  constructor({ rootResultsDir }) {
    this.rootResultsDir = rootResultsDir;
  }

  buildOutputPaths(settings, job) {
    const resultDir = toAbsolutePath(settings.output.resultDir || this.rootResultsDir);
    ensureDir(resultDir);

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const fallbackBase = `paylink-${job.startDate.replace(/\./g, "-")}-${job.endDate.replace(/\./g, "-")}-${timestamp}`;
    const fileName = normalizeFileName(job.requestedFileName || settings.output.defaultFileName, fallbackBase);

    return {
      resultDir,
      fileName,
      filePath: path.join(resultDir, fileName),
    };
  }

  saveExcel(data, settings, job) {
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.aoa_to_sheet(data);
    XLSX.utils.book_append_sheet(workbook, worksheet, "Results");

    const output = this.buildOutputPaths(settings, job);
    XLSX.writeFile(workbook, output.filePath);

    return output;
  }

  async getHealth(settings) {
    const loginUrl = `${settings.paylink.baseUrl.replace(/\/$/, "")}/login.php`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    try {
      const response = await fetch(loginUrl, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      return {
        ok: response.status < 500,
        label: response.status < 500 ? "Доступно" : "Недоступно",
        detail:
          response.status < 500
            ? `Paylink відповів зі статусом ${response.status}.`
            : `Paylink відповів зі статусом ${response.status}.`,
      };
    } catch (error) {
      clearTimeout(timeoutId);
      if (error.name === "AbortError") {
        return {
          ok: false,
          label: "Повільна відповідь",
          detail: "Paylink не відповів протягом 15 секунд.",
        };
      }

      return {
        ok: false,
        label: "Недоступно",
        detail: error.message,
      };
    }
  }

  async launchBrowser(settings) {
    return puppeteer.launch({
      headless: settings.browser.headless,
      defaultViewport: { width: 1600, height: 900 },
      args: [
        "--disable-blink-features=AutomationControlled",
        "--disable-dev-shm-usage",
        "--no-sandbox",
        ...(settings.browser.headless ? [] : ["--start-maximized"]),
      ],
    });
  }

  async preparePage(page) {
    await page.setViewport({ width: 1600, height: 900 });
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"
    );
    await page.setExtraHTTPHeaders({
      "accept-language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
    });

    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      Object.defineProperty(navigator, "language", { get: () => "ru-RU" });
      Object.defineProperty(navigator, "languages", { get: () => ["ru-RU", "ru", "en-US", "en"] });
      Object.defineProperty(navigator, "platform", { get: () => "MacIntel" });
      window.chrome = window.chrome || { runtime: {} };
    });
  }

  async saveDebugArtifacts(page, jobId, label) {
    ensureDir(DEBUG_DIR);
    const safeLabel = String(label).replace(/[^a-zA-Z0-9_-]+/g, "-").toLowerCase();
    const screenshotPath = path.join(DEBUG_DIR, `${safeLabel}-${jobId}.png`);
    const htmlPath = path.join(DEBUG_DIR, `${safeLabel}-${jobId}.html`);

    try {
      await page.screenshot({ path: screenshotPath, fullPage: true });
    } catch {}

    try {
      fs.writeFileSync(htmlPath, await page.content());
    } catch {}

    return { screenshotPath, htmlPath };
  }

  async waitForTransactionInput(page, timeout = 30000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeout) {
      if (await page.$("#tran-id")) return;
      await delay(500);
    }
    throw new Error("Waiting for selector `#tran-id` failed");
  }

  async openTransactionsSection(page, settings, jobTracker) {
    const baseUrl = settings.paylink.baseUrl.replace(/\/$/, "");
    const transactionsUrl = `${baseUrl}/#transactions`;

    jobTracker.update({ statusText: "Відкриття розділу транзакцій" });
    await page.goto(transactionsUrl, { waitUntil: "domcontentloaded" });
    await delay(1500);

    if (await page.$("#tran-id")) return;

    const menuLink = await page.$('a[data-hash="transactions"]');
    if (menuLink) {
      await menuLink.click();
      await delay(1500);
    }

    if (await page.$("#tran-id")) return;

    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await delay(1500);

    const secondMenuLink = await page.$('a[data-hash="transactions"]');
    if (secondMenuLink) {
      await secondMenuLink.click();
      await delay(1500);
    }

    await this.waitForTransactionInput(page, 30000);
  }

  async login(page, settings, jobTracker) {
    const loginUrl = `${settings.paylink.baseUrl.replace(/\/$/, "")}/login.php`;
    jobTracker.update({ statusText: "Відкриваємо сторінку входу Paylink" });

    await page.goto(loginUrl, { waitUntil: "domcontentloaded" });
    await delay(1000);

    await page.waitForSelector("#login", { timeout: 15000 });
    await page.type("#login", settings.paylink.login);

    let passwordSelector = "#text";
    if (!(await page.$(passwordSelector))) {
      passwordSelector = "#password";
      if (!(await page.$(passwordSelector))) {
        passwordSelector = 'input[type="password"]';
      }
    }

    await page.waitForSelector(passwordSelector, { timeout: 15000 });
    await page.type(passwordSelector, settings.paylink.password);
    await delay(500);

    jobTracker.update({ statusText: "Надсилання логіна й пароля Paylink" });

    await page.click("#auth-button");
    await Promise.race([
      page.waitForSelector('a[data-hash="transactions"]', { timeout: 30000 }).catch(() => null),
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null),
    ]);

    await this.openTransactionsSection(page, settings, jobTracker);
  }

  async ensureLogin(browser, settings, jobTracker) {
    const page = await browser.newPage();
    await this.preparePage(page);

    try {
      await this.login(page, settings, jobTracker);
      await this.waitForTransactionInput(page, 30000);
      jobTracker.log("Авторизація в Paylink успішна");
      return page;
    } catch (error) {
      const debug = await this.saveDebugArtifacts(page, jobTracker.job.id, "auth-failed");
      throw new Error(
        `Не вдалося відкрити сторінку транзакцій. Дані діагностики: ${debug.screenshotPath}, ${debug.htmlPath}. Причина: ${error.message}`
      );
    }
  }

  async processTransactions(page, data, transactions, jobTracker) {
    for (let index = 0; index < transactions.length; index += 1) {
      jobTracker.throwIfCanceled();
      const { tranid } = transactions[index];

      jobTracker.update({
        currentStep: index + 1,
        totalSteps: transactions.length,
        progress: transactions.length ? Math.round(((index + 1) / transactions.length) * 100) : 0,
        statusText: `Обробка ${tranid} (${index + 1}/${transactions.length})`,
      });

      try {
        jobTracker.throwIfCanceled();
        await page.waitForSelector("#tran-id", { timeout: 15000 });
        await page.evaluate(() => {
          const input = document.querySelector("#tran-id");
          if (input) input.value = "";
        });
        await delay(350);

        await page.type("#tran-id", tranid);
        await delay(350);
        await page.click("#get-transactions-btn");
        await delay(1200);

        const found = await page.waitForSelector(".open-transaction-details", { timeout: 15000 }).catch(() => null);
        if (!found) {
          data[index + 1][0] = "—";
          data[index + 1][1] = "—";
          data[index + 1][6] = "—";
          jobTracker.log(`${tranid}: не знайдено`);
          continue;
        }

        await page.click(".open-transaction-details");
        await delay(1000);
        jobTracker.throwIfCanceled();

        await page.waitForSelector("#preview-transaction-modal .modal-content", {
          visible: true,
          timeout: 15000,
        });

        let twoid = "";
        for (let attempt = 0; attempt < 5; attempt += 1) {
          twoid = await page
            .$eval("#preview-transaction-modal .modal-content #two-id", (el) => el.value)
            .catch(() => "");
          if (twoid && twoid.trim()) break;
          await delay(700);
        }

        const retailerFull = await page
          .$eval("#preview-transaction-modal .modal-content #merchant-id", (el) => el.value)
          .catch(() => "");
        const retailer = retailerFull?.substring(0, 6) || "";
        const date = await page
          .$eval("#preview-transaction-modal .modal-content #time", (el) => el.value)
          .catch(() => "");

        data[index + 1][0] = retailer || "—";
        data[index + 1][1] = date || "—";
        data[index + 1][6] = twoid || "—";

        await page.evaluate(() => {
          const modal = document.querySelector("#preview-transaction-modal");
          const button = modal?.querySelector("button.close");
          button?.click();
        });

        await page.waitForFunction(() => {
          const modal = document.querySelector("#preview-transaction-modal");
          return !modal || getComputedStyle(modal).display === "none";
        }, { timeout: 8000 });
      } catch (error) {
        data[index + 1][0] = "Помилка";
        data[index + 1][1] = "Помилка";
        data[index + 1][6] = "Помилка";
        jobTracker.log(`${tranid}: помилка ${error.message}`);
        await delay(500);
      }
    }
  }
}
