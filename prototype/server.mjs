import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  REPLY_SCHEMA,
  buildSystemPrompt,
  scriptedReply,
  validateReply,
} from "./prompt.mjs";

const prototypeRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.dirname(prototypeRoot);
const publicRoot = path.join(prototypeRoot, "public");

await loadEnv(path.join(prototypeRoot, ".env"));

const port = readInteger(process.env.PORT, 4175, 1, 65535);
const host = process.env.HOST?.trim() || (process.env.RENDER ? "0.0.0.0" : "127.0.0.1");
let openAIKey = process.env.OPENAI_API_KEY?.trim() || "";
const dialogueModel = process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini";
const transcribeModel = process.env.OPENAI_TRANSCRIBE_MODEL?.trim() || "gpt-4o-mini-transcribe";
const openAITimeoutMs = readInteger(process.env.OPENAI_TIMEOUT_MS, 12000, 1000, 30000);
const allowRuntimeApiKey = process.env.ALLOW_RUNTIME_API_KEY !== "false" && !process.env.RENDER;
const configuredOrigins = String(process.env.ALLOWED_ORIGINS || "https://bibliks.github.io")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const allowedOrigins = new Set([
  `http://127.0.0.1:${port}`,
  `http://localhost:${port}`,
  ...configuredOrigins,
]);
const rateBuckets = new Map();

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".glb", "model/gltf-binary"],
  [".mind", "application/octet-stream"],
  [".json", "application/json; charset=utf-8"],
]);

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", "http://localhost");

  try {
    if (url.pathname.startsWith("/api/")) {
      if (!hasAllowedOrigin(request)) return sendJson(response, 403, { error: "origin_not_allowed" });
      setCorsHeaders(request, response);
      if (request.method === "OPTIONS") {
        response.writeHead(204, { "Cache-Control": "no-store" });
        return response.end();
      }
      if (request.method === "POST" && !consumeRateLimit(request, url.pathname)) {
        return sendJson(response, 429, { error: "rate_limit_exceeded" });
      }
    }

    if (request.method === "GET" && url.pathname === "/api/health") {
      return sendJson(response, 200, {
        ok: true,
        openaiConfigured: Boolean(openAIKey),
        runtimeKeyConfiguration: allowRuntimeApiKey,
        model: dialogueModel,
      });
    }

    if (request.method === "POST" && url.pathname === "/api/configure") {
      if (!allowRuntimeApiKey) return sendJson(response, 404, { error: "runtime_configuration_disabled" });
      return await handleConfiguration(request, response);
    }

    if (request.method === "POST" && url.pathname === "/api/dialogue") {
      return await handleDialogue(request, response);
    }

    if (request.method === "POST" && url.pathname === "/api/transcribe") {
      return await handleTranscription(request, response);
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return sendJson(response, 405, { error: "method_not_allowed" });
    }

    return await serveStatic(url.pathname, request.method, response);
  } catch (error) {
    console.error("Request failed:", error instanceof Error ? error.message : "unknown error");
    return sendJson(response, 500, { error: "internal_error" });
  }
});

server.listen(port, host, () => {
  console.log(`SberKot prototype: http://${host}:${port}`);
  console.log(`OpenAI: ${openAIKey ? "configured" : "local scripted fallback"}`);
});

async function handleConfiguration(request, response) {
  const body = await readJson(request, 16 * 1024);
  const candidate = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (!candidate.startsWith("sk-") || candidate.length < 40 || candidate.length > 512) {
    return sendJson(response, 400, { error: "invalid_api_key_format" });
  }

  try {
    const apiResponse = await fetch("https://api.openai.com/v1/moderations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${candidate}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "omni-moderation-latest", input: "Проверка подключения." }),
      signal: AbortSignal.timeout(openAITimeoutMs),
    });

    if (apiResponse.status === 401 || apiResponse.status === 403) {
      return sendJson(response, 401, { error: "api_key_rejected" });
    }
    if (!apiResponse.ok) {
      return sendJson(response, 502, { error: "openai_unavailable" });
    }

    openAIKey = candidate;
    return sendJson(response, 200, { ok: true, openaiConfigured: true, model: dialogueModel });
  } catch {
    return sendJson(response, 502, { error: "openai_unavailable" });
  }
}

async function handleDialogue(request, response) {
  const body = await readJson(request, 64 * 1024);
  const profile = normalizeProfile(body.profile);
  const branch = normalizeBranch(body.branch, profile);
  const turn = readInteger(body.turn, 1, 1, 1000);
  const message = typeof body.message === "string" ? body.message.trim().slice(0, 300) : "";
  const history = normalizeHistory(body.history);
  const fallback = scriptedReply({ profile, branch, turn, message });

  if (!openAIKey) {
    return sendJson(response, 200, { reply: fallback, source: "local-fallback" });
  }

  try {
    if (message && message !== "__start__" && (await isFlagged(message))) {
      return sendJson(response, 200, {
        reply: {
          speech: "Давай выберем безопасную тему. Можешь сказать, что тебе интереснее: загадка или полезный совет.",
          animation: "idle",
          chips: ["Загадка", "Умный совет"],
          end_session: false,
        },
        source: "moderation-fallback",
      });
    }

    let reply = null;
    for (let attempt = 0; attempt < 2 && !reply; attempt += 1) {
      const generated = await generateReply({ profile, branch, turn, message, history, attempt });
      reply = validateReply(generated);
    }

    if (!reply || (await isFlagged([reply.speech, ...reply.chips].join("\n")))) {
      return sendJson(response, 200, { reply: fallback, source: "safety-fallback" });
    }

    return sendJson(response, 200, { reply, source: "openai" });
  } catch (error) {
    console.warn("Dialogue fallback:", error instanceof Error ? error.message : "OpenAI unavailable");
    return sendJson(response, 200, { reply: fallback, source: "network-fallback" });
  }
}

async function handleTranscription(request, response) {
  if (!openAIKey) {
    return sendJson(response, 503, { error: "openai_not_configured" });
  }

  const contentType = request.headers["content-type"] || "audio/webm";
  if (!String(contentType).startsWith("audio/")) {
    return sendJson(response, 415, { error: "audio_required" });
  }

  const audio = await readBody(request, 5 * 1024 * 1024);
  if (!audio.length) return sendJson(response, 400, { error: "empty_audio" });

  try {
    const form = new FormData();
    const audioExtension = String(contentType).includes("mp4") ? "mp4" : "webm";
    form.append("file", new Blob([audio], { type: String(contentType) }), `voice.${audioExtension}`);
    form.append("model", transcribeModel);
    form.append("language", "ru");

    const apiResponse = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${openAIKey}` },
      body: form,
      signal: AbortSignal.timeout(Math.max(openAITimeoutMs, 10000)),
    });
    const data = await apiResponse.json();
    if (!apiResponse.ok) throw new Error(openAIErrorLabel("transcription", apiResponse.status, data));

    const text = typeof data.text === "string" ? data.text.trim().slice(0, 300) : "";
    if (!text) return sendJson(response, 422, { error: "speech_not_recognized" });
    return sendJson(response, 200, { text });
  } catch (error) {
    console.warn("Transcription unavailable:", error instanceof Error ? error.message : "unknown error");
    return sendJson(response, 503, { error: "transcription_unavailable" });
  }
}

async function generateReply({ profile, branch, turn, message, history, attempt }) {
  const systemPrompt = buildSystemPrompt({ profile, branch, turn });
  const messages = [
    {
      role: "system",
      content: systemPrompt,
    },
    ...history.map((item) => ({
      role: item.role,
      content: item.content,
    })),
    {
      role: "user",
      content:
        message === "__start__"
          ? "Начни короткую сцену приветствия."
          : message || "Продолжи сцену безопасно и коротко.",
    },
  ];

  if (attempt > 0) {
    messages[0].content += "\nПредыдущий ответ не прошёл проверку. Строго соблюдай схему и ограничения.";
  }

  const apiResponse = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openAIKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: dialogueModel,
      input: messages,
      text: {
        format: {
          type: "json_schema",
          name: "sberkot_reply",
          strict: true,
          schema: REPLY_SCHEMA,
        },
      },
      max_output_tokens: 300,
      store: false,
    }),
    signal: AbortSignal.timeout(openAITimeoutMs),
  });
  const data = await apiResponse.json();
  if (!apiResponse.ok) throw new Error(openAIErrorLabel("responses", apiResponse.status, data));

  const outputText =
    data.output_text ||
    data.output
      ?.flatMap((item) => item.content || [])
      .find((content) => content.type === "output_text")?.text;
  if (typeof outputText !== "string") return null;

  try {
    return JSON.parse(outputText);
  } catch {
    return null;
  }
}

async function isFlagged(input) {
  const apiResponse = await fetch("https://api.openai.com/v1/moderations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openAIKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: "omni-moderation-latest", input }),
    signal: AbortSignal.timeout(openAITimeoutMs),
  });
  const data = await apiResponse.json();
  if (!apiResponse.ok) throw new Error(`moderation_${apiResponse.status}`);
  return Boolean(data.results?.[0]?.flagged);
}

function normalizeProfile(value) {
  const hasAccount = Boolean(value?.has_account);
  const bucket = ["active", "dormant", "unknown"].includes(value?.activity_bucket)
    ? value.activity_bucket
    : "unknown";
  return { has_account: hasAccount, activity_bucket: hasAccount ? bucket : "unknown" };
}

function normalizeBranch(value, profile) {
  const allowed = ["no_app", "active", "dormant", "repeat_same_day", "guest_fallback"];
  if (allowed.includes(value)) return value;
  if (!profile.has_account) return "no_app";
  return profile.activity_bucket === "dormant" ? "dormant" : "active";
}

function normalizeHistory(value) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(-24)
    .filter((item) => item && ["user", "assistant"].includes(item.role))
    .map((item) => ({
      role: item.role,
      content: String(item.content || "").trim().slice(0, 300),
    }))
    .filter((item) => item.content);
}

function openAIErrorLabel(endpoint, status, data) {
  const code = String(data?.error?.code || data?.error?.type || "unknown")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 80);
  return `${endpoint}_${status}_${code}`;
}

async function serveStatic(pathname, method, response) {
  const assetMap = new Map([
    ["/assets/character.glb", path.join(projectRoot, "character.glb")],
    ["/assets/card.mind", path.join(projectRoot, "card.mind")],
    ["/assets/marker.png", path.join(projectRoot, "marker.png")],
  ]);

  let filePath = assetMap.get(pathname);
  if (!filePath) {
    const publicRoutes = new Map([
      ["/", "index.html"],
      ["/without-app", "index.html"],
      ["/without-app/", "index.html"],
      ["/with-app", "index.html"],
      ["/with-app/", "index.html"],
      ["/app.css", "app.css"],
      ["/app.js", "app.js"],
    ]);
    const relativePath = publicRoutes.get(pathname);
    if (!relativePath) return sendJson(response, 404, { error: "not_found" });
    filePath = path.join(publicRoot, relativePath);
  }

  const data = await readFile(filePath);
  const extension = path.extname(filePath).toLowerCase();
  response.writeHead(200, {
    "Content-Type": mimeTypes.get(extension) || "application/octet-stream",
    "Content-Length": data.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  response.end(method === "HEAD" ? undefined : data);
}

async function readJson(request, limit) {
  const body = await readBody(request, limit);
  try {
    return JSON.parse(body.toString("utf8") || "{}");
  } catch {
    const error = new Error("invalid_json");
    error.statusCode = 400;
    throw error;
  }
}

function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("payload_too_large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function sendJson(response, status, value) {
  if (response.headersSent) return;
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function hasAllowedOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  return allowedOrigins.has(origin);
}

function setCorsHeaders(request, response) {
  const origin = request.headers.origin;
  if (!origin || !allowedOrigins.has(origin)) return;
  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Vary", "Origin");
}

function consumeRateLimit(request, pathname) {
  const limits = {
    "/api/configure": 5,
    "/api/dialogue": 40,
    "/api/transcribe": 20,
  };
  const limit = limits[pathname] || 20;
  const clientAddress = String(
    request.headers["cf-connecting-ip"] ||
    request.headers["x-forwarded-for"] ||
    request.socket.remoteAddress ||
    "unknown",
  ).split(",")[0].trim();
  const key = `${clientAddress}:${pathname}`;
  const now = Date.now();
  const current = rateBuckets.get(key);
  if (!current || now - current.startedAt >= 10 * 60 * 1000) {
    rateBuckets.set(key, { count: 1, startedAt: now });
    return true;
  }
  current.count += 1;
  return current.count <= limit;
}

function readInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

async function loadEnv(filePath) {
  try {
    const content = await readFile(filePath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!match || match[0].trimStart().startsWith("#") || process.env[match[1]]) continue;
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
