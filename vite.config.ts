import { defineConfig } from "vite";

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

export default defineConfig({
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
});
