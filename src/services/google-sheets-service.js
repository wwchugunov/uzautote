import { google } from "googleapis";
import fs from "fs";
import { formatDateForInput, formatDateForSheet, parseSheetDate } from "../utils/date.js";
import { parseSpreadsheetId } from "../utils/spreadsheet.js";
import { toAbsolutePath } from "../utils/fs.js";

function formatAmountValue(rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === "") return "";
  const normalized = String(rawValue).replace(",", ".");
  const numeric = Number.parseFloat(normalized);
  if (Number.isNaN(numeric)) return "";
  return (numeric / 100).toFixed(2).replace(".", ",");
}

function normalizeTranid(value) {
  return String(value || "")
    .trim()
    .replace(/^IPAY_/i, "")
    .toUpperCase();
}

function getAvailableDateSheets(sheetsList) {
  return sheetsList
    .map((sheet) => {
      const title = sheet.properties?.title || "";
      const parsedDate = parseSheetDate(title);
      return parsedDate ? { title, parsedDate } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.parsedDate - b.parsedDate);
}

function getSheetNamesByRange(availableSheets, startDateRaw, endDateRaw) {
  if (!startDateRaw || !endDateRaw) {
    throw new Error("Потрібно вказати обидві дати діапазону.");
  }

  const startDate = parseSheetDate(startDateRaw);
  const endDate = parseSheetDate(endDateRaw);

  if (!startDate || !endDate) {
    throw new Error("Дати мають бути у форматі ДД.ММ.РРРР.");
  }

  if (startDate > endDate) {
    throw new Error("Дата 'від' не може бути пізнішою за дату 'до'.");
  }

  const sheetNames = availableSheets
    .filter((sheet) => sheet.parsedDate >= startDate && sheet.parsedDate <= endDate)
    .map((sheet) => sheet.title);

  return {
    sheetNames,
    normalizedStartDate: formatDateForSheet(startDate),
    normalizedEndDate: formatDateForSheet(endDate),
  };
}

export class GoogleSheetsService {
  async getSheetsClient(settings) {
    const auth = new google.auth.GoogleAuth({
      keyFile: toAbsolutePath(settings.google.keyFile),
      scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    });

    const client = await auth.getClient();
    return google.sheets({ version: "v4", auth: client });
  }

  async getSpreadsheetSheets(settings) {
    const spreadsheetId = parseSpreadsheetId(settings.google.spreadsheetUrl);
    const sheets = await this.getSheetsClient(settings);
    const sheetInfo = await sheets.spreadsheets.get({ spreadsheetId });

    return {
      sheets,
      spreadsheetId,
      sheetsList: sheetInfo.data.sheets || [],
    };
  }

  async getUiMetadata(settings) {
    const { sheetsList } = await this.getSpreadsheetSheets(settings);
    const availableSheets = getAvailableDateSheets(sheetsList).map((sheet) => sheet.title);
    const firstSheet = availableSheets[0] || "";
    const lastSheet = availableSheets.at(-1) || "";

    return {
      availableSheets,
      firstSheet,
      lastSheet,
      firstSheetInput: formatDateForInput(firstSheet),
      lastSheetInput: formatDateForInput(lastSheet),
    };
  }

  async getHealth(settings) {
    const keyFilePath = toAbsolutePath(settings.google.keyFile);
    const health = {
      googleSheets: {
        ok: false,
        label: "Недоступно",
        detail: "Не вдалося підключитися до Google Sheets.",
      },
      googleKey: {
        ok: false,
        label: "Недійсний",
        detail: "Ключ Google не перевірено.",
      },
    };

    if (!keyFilePath || !fs.existsSync(keyFilePath)) {
      health.googleKey.detail = "Файл key.json не знайдено.";
      return health;
    }

    try {
      const auth = new google.auth.GoogleAuth({
        keyFile: keyFilePath,
        scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
      });

      await auth.getClient();
      health.googleKey.ok = true;
      health.googleKey.label = "Валідний";
      health.googleKey.detail = "Сервісний ключ Google читається коректно.";
    } catch (error) {
      health.googleKey.detail = error.message;
      return health;
    }

    try {
      const { sheetsList } = await this.getSpreadsheetSheets(settings);
      health.googleSheets.ok = true;
      health.googleSheets.label = "Доступно";
      health.googleSheets.detail = `Підключення успішне, аркушів: ${sheetsList.length}.`;
    } catch (error) {
      health.googleSheets.detail = error.message;
    }

    return health;
  }

  async searchTransaction(settings, inputTranid) {
    const requestedTranid = String(inputTranid || "").trim();
    if (!requestedTranid) {
      throw new Error("Вкажіть TRANID для пошуку.");
    }

    const normalizedTarget = normalizeTranid(requestedTranid);
    const { sheets, spreadsheetId, sheetsList } = await this.getSpreadsheetSheets(settings);
    const sheetNames = (sheetsList || [])
      .map((sheet) => sheet.properties?.title || "")
      .filter(Boolean);

    const matches = [];

    for (const [index, sheetName] of sheetNames.entries()) {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${sheetName}!A:D`,
      });

      const rows = response.data.values || [];
      for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
        const [tranid, pan, amountOriginalRaw, amountRefundRaw] = rows[rowIndex] || [];
        if (!tranid) continue;

        if (normalizeTranid(tranid) !== normalizedTarget) continue;

        matches.push({
          sheetName,
          sheetOrder: index + 1,
          rowNumber: rowIndex + 1,
          tranid: `IPAY_${normalizeTranid(tranid)}`,
          pan: pan || "",
          amountOriginal: formatAmountValue(amountOriginalRaw),
          amountRefund: formatAmountValue(amountRefundRaw),
        });
      }
    }

    return {
      requestedTranid: requestedTranid.toUpperCase(),
      normalizedTranid: `IPAY_${normalizedTarget}`,
      matches,
      totalSheets: sheetNames.length,
    };
  }

  async readRange({ settings, startDate, endDate, jobTracker }) {
    jobTracker.update({ statusText: "Читання даних із Google Sheets..." });
    jobTracker.throwIfCanceled();

    const { sheets, spreadsheetId, sheetsList } = await this.getSpreadsheetSheets(settings);
    const availableSheets = getAvailableDateSheets(sheetsList);

    if (!availableSheets.length) {
      throw new Error("У таблиці не знайдено аркушів із датами у форматі ДД.ММ.РРРР.");
    }

    const { sheetNames, normalizedStartDate, normalizedEndDate } = getSheetNamesByRange(
      availableSheets,
      startDate,
      endDate
    );

    if (!sheetNames.length) {
      throw new Error(`Не знайдено аркушів у діапазоні ${normalizedStartDate} - ${normalizedEndDate}.`);
    }

    let rows = [];

    for (const [index, sheetName] of sheetNames.entries()) {
      jobTracker.throwIfCanceled();
      jobTracker.update({
        statusText: `Читання аркуша ${sheetName} (${index + 1}/${sheetNames.length})`,
        selectedSheets: sheetNames,
      });

      const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${sheetName}!A:D`,
      });

      const sheetRows = response.data.values || [];
      if (sheetRows.length > 1) {
        rows = rows.concat(sheetRows.slice(1));
      }
    }

    const data = [
      ["RETAIL", "DATE", "AMOUNT ORIGINAL", "AMOUNT REFUND", "PAN", "TRANID", "TWOID", "NEW PAN"],
    ];
    const transactions = [];

    for (let index = 0; index < rows.length; index += 1) {
      const [tranid, pan, amountOriginalRaw, amountRefundRaw] = rows[index] || [];
      if (!tranid) continue;

      const formattedTranid = `IPAY_${String(tranid).trim()}`;
      data.push([
        "",
        "",
        formatAmountValue(amountOriginalRaw),
        formatAmountValue(amountRefundRaw),
        pan || "",
        formattedTranid,
        "",
        "",
      ]);
      transactions.push({ row: index + 1, tranid: formattedTranid });
    }

    jobTracker.log(`Знайдено транзакцій: ${transactions.length}`);

    return {
      data,
      transactions,
      selectedSheets: sheetNames,
      availableSheets: availableSheets.map((sheet) => sheet.title),
      normalizedStartDate,
      normalizedEndDate,
    };
  }
}
