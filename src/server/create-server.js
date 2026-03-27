import fs from "fs";
import http from "http";
import { APP_BASE_PATH, HTML_FILE, PORT, RESULTS_DIR, UPLOADS_DIR, DEBUG_DIR } from "../config.js";
import { ensureDir } from "../utils/fs.js";
import { parseJsonBody, readRequestBody, sendJson } from "../utils/http.js";

function stripAppBasePath(pathname) {
  if (!APP_BASE_PATH) return pathname;
  if (pathname === APP_BASE_PATH || pathname === `${APP_BASE_PATH}/`) return "/";
  if (pathname.startsWith(`${APP_BASE_PATH}/`)) {
    return pathname.slice(APP_BASE_PATH.length) || "/";
  }
  return pathname;
}

async function requireSession(request, response, sessionService) {
  const session = sessionService.getSession(request);
  if (!session) {
    sendJson(response, 401, { ok: false, error: "Потрібна авторизація." });
    return null;
  }
  return session;
}

export function createServer({
  settingsService,
  sessionService,
  jobService,
  googleSheetsService,
  paylinkService,
}) {
  ensureDir(RESULTS_DIR);
  ensureDir(UPLOADS_DIR);
  ensureDir(DEBUG_DIR);
  settingsService.ensureFile();

  async function handleRequest(request, response) {
    const requestUrl = new URL(request.url, `http://${request.headers.host}`);
    const pathname = stripAppBasePath(requestUrl.pathname);

    if (request.method === "GET" && pathname === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(fs.readFileSync(HTML_FILE, "utf8"));
      return;
    }

    if (request.method === "POST" && pathname === "/api/login") {
      try {
        const settings = settingsService.load();
        const body = parseJsonBody(await readRequestBody(request));
        const username = String(body.username || "").trim();
        const password = String(body.password || "").trim();

        if (username !== settings.appAuth.username || password !== settings.appAuth.password) {
          sendJson(response, 401, { ok: false, error: "Неправильний логін або пароль." });
          return;
        }

        const token = sessionService.createSession(username);
        sendJson(
          response,
          200,
          { ok: true, username },
          { "Set-Cookie": sessionService.getSessionCookie(token) }
        );
      } catch (error) {
        sendJson(response, 400, { ok: false, error: error.message });
      }
      return;
    }

    if (request.method === "POST" && pathname === "/api/logout") {
      sessionService.destroySession(request);
      sendJson(
        response,
        200,
        { ok: true },
        { "Set-Cookie": sessionService.getExpiredSessionCookie() }
      );
      return;
    }

    if (request.method === "GET" && pathname === "/api/session") {
      const session = sessionService.getSession(request);
      sendJson(response, 200, {
        ok: true,
        authenticated: Boolean(session),
        username: session?.username || "",
      });
      return;
    }

    const session = await requireSession(request, response, sessionService);
    if (!session) return;

    if (request.method === "GET" && pathname === "/api/meta") {
      try {
        const settings = settingsService.load();
        const [meta, googleHealth, paylinkHealth] = await Promise.all([
          googleSheetsService.getUiMetadata(settings),
          googleSheetsService.getHealth(settings),
          paylinkService.getHealth(settings),
        ]);
        sendJson(response, 200, {
          ok: true,
          ...meta,
          health: {
            googleSheets: googleHealth.googleSheets,
            googleKey: googleHealth.googleKey,
            paylink: paylinkHealth,
          },
          settings: settingsService.toPublic(settings),
          jobs: jobService.list(),
          activeJobId: jobService.getActiveJobId(),
          now: new Date().toISOString(),
        });
      } catch (error) {
        sendJson(response, 500, { ok: false, error: error.message });
      }
      return;
    }

    if (request.method === "GET" && pathname === "/api/health") {
      try {
        const settings = settingsService.load();
        const [googleHealth, paylinkHealth] = await Promise.all([
          googleSheetsService.getHealth(settings),
          paylinkService.getHealth(settings),
        ]);

        sendJson(response, 200, {
          ok: true,
          health: {
            googleSheets: googleHealth.googleSheets,
            googleKey: googleHealth.googleKey,
            paylink: paylinkHealth,
          },
          now: new Date().toISOString(),
        });
      } catch (error) {
        sendJson(response, 500, { ok: false, error: error.message });
      }
      return;
    }

    if (request.method === "POST" && pathname === "/api/settings") {
      try {
        const currentSettings = settingsService.load();
        const body = parseJsonBody(await readRequestBody(request));

        let nextKeyFile = body.google?.keyFile || currentSettings.google.keyFile;
        if (body.google?.uploadedKeyFileContent) {
          nextKeyFile = settingsService.writeUploadedKeyFile(
            body.google.uploadedKeyFileContent,
            body.google.uploadedKeyFileName || "key.json"
          );
        }

        const nextSettings = settingsService.validate({
          appAuth: {
            username: body.appAuth?.username ?? currentSettings.appAuth.username,
            password: body.appAuth?.password || currentSettings.appAuth.password,
          },
          paylink: body.paylink,
          google: {
            spreadsheetUrl: body.google?.spreadsheetUrl,
            keyFile: nextKeyFile,
          },
          output: body.output,
          browser: {
            headless:
              typeof body.browser?.headless === "boolean"
                ? body.browser.headless
                : currentSettings.browser.headless,
          },
        });

        settingsService.save(nextSettings);
        sendJson(response, 200, { ok: true, settings: settingsService.toPublic(nextSettings) });
      } catch (error) {
        sendJson(response, 400, { ok: false, error: error.message });
      }
      return;
    }

    if (request.method === "POST" && pathname === "/api/jobs") {
      try {
        const body = parseJsonBody(await readRequestBody(request));
        const job = await jobService.enqueue({
          startDate: body.startDate ? body.startDate.split("-").reverse().join(".") : "",
          endDate: body.endDate ? body.endDate.split("-").reverse().join(".") : "",
          username: session.username,
          requestedFileName: String(body.fileName || "").trim(),
        });
        sendJson(response, 202, { ok: true, job });
      } catch (error) {
        sendJson(response, 400, { ok: false, error: error.message });
      }
      return;
    }

    if (request.method === "GET" && pathname === "/api/jobs") {
      sendJson(response, 200, {
        ok: true,
        jobs: jobService.list(),
        activeJobId: jobService.getActiveJobId(),
        now: new Date().toISOString(),
      });
      return;
    }

    if (request.method === "GET" && pathname === "/api/search/transaction") {
      try {
        const settings = settingsService.load();
        const tranid = requestUrl.searchParams.get("tranid") || "";
        const result = await googleSheetsService.searchTransaction(settings, tranid);
        sendJson(response, 200, { ok: true, ...result });
      } catch (error) {
        sendJson(response, 400, { ok: false, error: error.message });
      }
      return;
    }

    const cancelMatch = pathname.match(/^\/api\/jobs\/([a-zA-Z0-9-]+)\/cancel$/);
    if (request.method === "POST" && cancelMatch) {
      try {
        const job = await jobService.cancel(cancelMatch[1]);
        sendJson(response, 200, { ok: true, job });
      } catch (error) {
        sendJson(response, 400, { ok: false, error: error.message });
      }
      return;
    }

    const statusMatch = pathname.match(/^\/api\/jobs\/([a-zA-Z0-9-]+)$/);
    if (request.method === "GET" && statusMatch) {
      const job = jobService.getById(statusMatch[1]);
      if (!job) {
        sendJson(response, 404, { ok: false, error: "Завдання не знайдено." });
        return;
      }
      sendJson(response, 200, { ok: true, job });
      return;
    }

    const downloadMatch = pathname.match(/^\/api\/jobs\/([a-zA-Z0-9-]+)\/download$/);
    if (request.method === "GET" && downloadMatch) {
      const job = jobService.getById(downloadMatch[1]);
      if (!job || !job.filePath || !fs.existsSync(job.filePath)) {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Файл не знайдено");
        return;
      }

      response.writeHead(200, {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${job.fileName}"`,
      });
      fs.createReadStream(job.filePath).pipe(response);
      return;
    }

    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Не знайдено");
  }

  return http.createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      console.error(error);
      sendJson(response, 500, { ok: false, error: "Внутрішня помилка сервера." });
    });
  });
}

export function startServer(server) {
  server.listen(PORT, () => {
    console.log(`Інтерфейс запущено: http://localhost:${PORT}`);
  });
}
