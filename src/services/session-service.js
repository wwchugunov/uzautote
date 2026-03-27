import crypto from "crypto";
import { SESSION_COOKIE, SESSION_COOKIE_PATH } from "../config.js";
import { getCookieMap } from "../utils/http.js";

export class SessionService {
  constructor() {
    this.sessions = new Map();
  }

  getSession(request) {
    const cookies = getCookieMap(request);
    const token = cookies[SESSION_COOKIE];
    return token ? this.sessions.get(token) || null : null;
  }

  createSession(username) {
    const token = crypto.randomBytes(24).toString("hex");
    this.sessions.set(token, { username, createdAt: Date.now() });
    return token;
  }

  destroySession(request) {
    const cookies = getCookieMap(request);
    if (cookies[SESSION_COOKIE]) {
      this.sessions.delete(cookies[SESSION_COOKIE]);
    }
  }

  getSessionCookie(token) {
    return `${SESSION_COOKIE}=${token}; HttpOnly; Path=${SESSION_COOKIE_PATH}; SameSite=Lax`;
  }

  getExpiredSessionCookie() {
    return `${SESSION_COOKIE}=; HttpOnly; Path=${SESSION_COOKIE_PATH}; Max-Age=0; SameSite=Lax`;
  }
}
