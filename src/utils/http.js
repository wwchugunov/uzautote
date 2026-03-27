export function sendJson(response, statusCode, payload, extraHeaders = {}) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    ...extraHeaders,
  });
  response.end(JSON.stringify(payload));
}

export function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";

    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 10_000_000) {
        reject(new Error("Надто великий запит."));
      }
    });

    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

export function parseJsonBody(rawBody) {
  return JSON.parse(rawBody || "{}");
}

export function getCookieMap(request) {
  const header = request.headers.cookie || "";
  return header.split(";").reduce((acc, item) => {
    const [key, ...rest] = item.trim().split("=");
    if (!key) return acc;
    acc[key] = decodeURIComponent(rest.join("="));
    return acc;
  }, {});
}
