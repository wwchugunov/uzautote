import { google } from "googleapis";
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
    throw new Error("Нужно указать обе даты диапазона.");
  }

  const startDate = parseSheetDate(startDateRaw);
  const endDate = parseSheetDate(endDateRaw);

  if (!startDate || !endDate) {
    throw new Error("Даты должны быть в формате ДД.ММ.ГГГГ.");
  }

  if (startDate > endDate) {
    throw new Error("Дата 'с' не может быть позже даты 'по'.");
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

  async readRange({ settings, startDate, endDate, jobTracker }) {
    jobTracker.update({ statusText: "Чтение данных из Google Sheets..." });
    jobTracker.throwIfCanceled();

    const { sheets, spreadsheetId, sheetsList } = await this.getSpreadsheetSheets(settings);
    const availableSheets = getAvailableDateSheets(sheetsList);

    if (!availableSheets.length) {
      throw new Error("В таблице не найдено листов с датами в формате ДД.ММ.ГГГГ.");
    }

    const { sheetNames, normalizedStartDate, normalizedEndDate } = getSheetNamesByRange(
      availableSheets,
      startDate,
      endDate
    );

    if (!sheetNames.length) {
      throw new Error(`Не найдено листов в диапазоне ${normalizedStartDate} - ${normalizedEndDate}.`);
    }

    let rows = [];

    for (const [index, sheetName] of sheetNames.entries()) {
      jobTracker.throwIfCanceled();
      jobTracker.update({
        statusText: `Чтение листа ${sheetName} (${index + 1}/${sheetNames.length})`,
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

    jobTracker.log(`Найдено транзакций: ${transactions.length}`);

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
