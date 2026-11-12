import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Connect, type Plugin } from "vite";

const root = dirname(fileURLToPath(import.meta.url));
const POSTMORTEM_FILE = resolve(root, "logs", "command-postmortem.log");

/** Dev/preview proxies so browser LLM calls avoid CORS. */
const llmProxy = {
  "/llm/openai": {
    target: "https://api.openai.com",
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/llm\/openai/, ""),
  },
  "/llm/openrouter": {
    target: "https://openrouter.ai",
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/llm\/openrouter/, ""),
  },
  "/llm/gemini": {
    target: "https://generativelanguage.googleapis.com",
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/llm\/gemini/, ""),
  },
  "/llm/anthropic": {
    target: "https://api.anthropic.com",
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/llm\/anthropic/, ""),
  },
} as const;

/** One text line per recognized command: when, mode, team, sentence, handler, goals. */
function postmortemLine(body: Record<string, unknown>): string {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const goals = Array.isArray(body.goals) && body.goals.length ? body.goals.join("; ") : "-";
  const when = str(body.at).replace("T", " ").replace(/\.\d+Z$/, "Z");
  const text = str(body.text).replace(/\s+/g, " ");
  const evalRaw = body.jannaEval;
  const scripted = body.source === "ai_commander";
  const janna = scripted ? "not scored" :
    evalRaw === "pass" || evalRaw === "fail" ? evalRaw : "—";
  const metadata = scripted ? `  ${JSON.stringify({
    source: body.source, intent: body.intent, tanks: body.tanks,
    reason: body.reason, seed: body.seed, issuedAt: body.issuedAt,
  })}` : "";
  return `${when}  ${str(body.mode)}  ${str(body.team)}  "${text}"  ->  ${str(body.handler)}  [${janna}]  (${goals})${metadata}\n`;
}

const commandLogEndpoint: Connect.NextHandleFunction = (req, res, next) => {
  if (req.url !== "/__command-log" || req.method !== "POST") return next();
  let raw = "";
  req.setEncoding("utf8");
  req.on("data", (chunk: string) => {
    raw += chunk;
    if (raw.length > 16_384) req.destroy();
  });
  req.on("end", async () => {
    try {
      const body = JSON.parse(raw) as Record<string, unknown>;
      await mkdir(dirname(POSTMORTEM_FILE), { recursive: true });
      await appendFile(POSTMORTEM_FILE, postmortemLine(body), "utf8");
      res.statusCode = 204;
    } catch {
      res.statusCode = 400;
    }
    res.end();
  });
};

/** Appends recognized commands to logs/command-postmortem.log while dev or preview runs. */
function commandPostmortemLog(): Plugin {
  return {
    name: "command-postmortem-log",
    configureServer(server) {
      server.middlewares.use(commandLogEndpoint);
    },
    configurePreviewServer(server) {
      server.middlewares.use(commandLogEndpoint);
    },
  };
}

export default defineConfig({
  plugins: [commandPostmortemLog()],
  server: {
    host: "0.0.0.0",
    port: 4847,
    proxy: llmProxy,
  },
  preview: {
    host: "0.0.0.0",
    port: 4848,
    proxy: llmProxy,
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(root, "index.html"),
        postmortem: resolve(root, "postmortem.html"),
      },
    },
  },
});
