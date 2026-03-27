import crypto from "crypto";

function createJobTracker(jobService, job) {
  return {
    job,
    update: (patch) => jobService.updateJob(job.id, patch),
    log: (message) => jobService.appendLog(job.id, message),
    throwIfCanceled: () => jobService.throwIfCanceled(job),
  };
}

export class JobService {
  constructor({ settingsService, googleSheetsService, paylinkService }) {
    this.settingsService = settingsService;
    this.googleSheetsService = googleSheetsService;
    this.paylinkService = paylinkService;

    this.jobs = [];
    this.jobMap = new Map();
    this.activeJobId = null;
    this.activeBrowser = null;
    this.activePage = null;
  }

  list() {
    return this.jobs.slice(0, 20);
  }

  getActiveJobId() {
    return this.activeJobId;
  }

  getById(jobId) {
    return this.jobMap.get(jobId) || null;
  }

  appendLog(jobId, message) {
    const job = this.getById(jobId);
    if (!job) return;
    const timestamp = new Date().toLocaleTimeString("ru-RU");
    job.logs.push(`[${timestamp}] ${message}`);
    if (job.logs.length > 120) {
      job.logs = job.logs.slice(-120);
    }
  }

  updateJob(jobId, patch) {
    const job = this.getById(jobId);
    if (!job) return;

    if (patch.statusText && patch.statusText !== job.statusText) {
      this.appendLog(jobId, patch.statusText);
    }

    Object.assign(job, patch);
  }

  isCanceled(job) {
    return Boolean(job?.cancelRequested || job?.status === "canceled");
  }

  throwIfCanceled(job) {
    if (this.isCanceled(job)) {
      throw new Error("Завдання скасовано користувачем.");
    }
  }

  create({ startDate, endDate, username, requestedFileName }) {
    const job = {
      id: crypto.randomUUID(),
      status: "queued",
      statusText: "В очереди",
      progress: 0,
      currentStep: 0,
      totalSteps: 0,
      requestedBy: username,
      requestedFileName,
      startDate,
      endDate,
      selectedSheets: [],
      transactionCount: 0,
      fileName: "",
      filePath: "",
      downloadUrl: "",
      createdAt: new Date().toISOString(),
      startedAt: "",
      finishedAt: "",
      error: "",
      logs: [],
      cancelRequested: false,
    };

    this.jobs.unshift(job);
    this.jobMap.set(job.id, job);
    this.appendLog(job.id, "Задача создана");

    return job;
  }

  async enqueue(params) {
    const job = this.create(params);
    this.processQueue().catch((error) => {
      this.updateJob(job.id, {
        status: "error",
        statusText: "Ошибка",
        error: error.message,
        finishedAt: new Date().toISOString(),
      });
    });
    return job;
  }

  async processQueue() {
    if (this.activeJobId) return;
    const nextJob = this.jobs.find((job) => job.status === "queued");
    if (!nextJob) return;
    await this.run(nextJob);
  }

  async run(job) {
    this.activeJobId = job.id;
    this.activeBrowser = null;
    this.activePage = null;

    const settings = this.settingsService.load();
    const tracker = createJobTracker(this, job);

    this.updateJob(job.id, {
      status: "running",
      startedAt: new Date().toISOString(),
      statusText: "Запуск браузера",
      progress: 1,
    });

    const browser = await this.paylinkService.launchBrowser(settings);
    this.activeBrowser = browser;

    try {
      tracker.throwIfCanceled();

      const { data, transactions, selectedSheets, normalizedStartDate, normalizedEndDate } =
        await this.googleSheetsService.readRange({
          settings,
          startDate: job.startDate,
          endDate: job.endDate,
          jobTracker: tracker,
        });

      this.updateJob(job.id, {
        selectedSheets,
        startDate: normalizedStartDate,
        endDate: normalizedEndDate,
        transactionCount: transactions.length,
        totalSteps: transactions.length,
        statusText: "Авторизация в Paylink",
        progress: 5,
      });

      const page = await this.paylinkService.ensureLogin(browser, settings, tracker);
      this.activePage = page;

      tracker.throwIfCanceled();
      await this.paylinkService.processTransactions(page, data, transactions, tracker);
      tracker.throwIfCanceled();

      this.updateJob(job.id, {
        statusText: "Сохранение Excel",
        progress: 98,
      });

      const saved = this.paylinkService.saveExcel(data, settings, job);
      this.updateJob(job.id, {
        status: "done",
        progress: 100,
        statusText: "Готово",
        fileName: saved.fileName,
        filePath: saved.filePath,
        downloadUrl: `/api/jobs/${job.id}/download`,
        finishedAt: new Date().toISOString(),
      });
    } catch (error) {
      if (this.isCanceled(job) || error.message === "Завдання скасовано користувачем.") {
        this.updateJob(job.id, {
          status: "canceled",
          statusText: "Скасовано",
          error: "",
          finishedAt: new Date().toISOString(),
          progress: 0,
        });
        this.appendLog(job.id, "Виконання зупинено");
      } else {
        this.updateJob(job.id, {
          status: "error",
          statusText: "Ошибка",
          error: error.message,
          finishedAt: new Date().toISOString(),
        });
      }
    } finally {
      this.activeJobId = null;
      this.activePage = null;
      this.activeBrowser = null;
      await browser.close().catch(() => {});
      this.processQueue().catch((error) => console.error("Queue error:", error));
    }
  }

  async cancel(jobId) {
    const job = this.getById(jobId);
    if (!job) {
      throw new Error("Завдання не знайдено.");
    }

    if (["done", "error", "canceled"].includes(job.status)) {
      throw new Error("Це завдання вже завершене.");
    }

    job.cancelRequested = true;

    if (job.status === "queued") {
      this.updateJob(job.id, {
        status: "canceled",
        statusText: "Скасовано",
        finishedAt: new Date().toISOString(),
        progress: 0,
        error: "",
      });
      this.appendLog(job.id, "Завдання знято з черги");
      return job;
    }

    if (job.status === "running") {
      this.updateJob(job.id, { statusText: "Зупинка завдання" });
      if (this.activePage) {
        await this.activePage.close().catch(() => {});
      }
      if (this.activeBrowser) {
        await this.activeBrowser.close().catch(() => {});
      }
    }

    return job;
  }
}
