import { RESULTS_DIR } from "./src/config.js";
import { GoogleSheetsService } from "./src/services/google-sheets-service.js";
import { JobService } from "./src/services/job-service.js";
import { PaylinkService } from "./src/services/paylink-service.js";
import { SessionService } from "./src/services/session-service.js";
import { SettingsService } from "./src/services/settings-service.js";
import { createServer, startServer } from "./src/server/create-server.js";

const settingsService = new SettingsService();
const sessionService = new SessionService();
const googleSheetsService = new GoogleSheetsService();
const paylinkService = new PaylinkService({ rootResultsDir: RESULTS_DIR });
const jobService = new JobService({
  settingsService,
  googleSheetsService,
  paylinkService,
});

const server = createServer({
  settingsService,
  sessionService,
  jobService,
  googleSheetsService,
});

startServer(server);
