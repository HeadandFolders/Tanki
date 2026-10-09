import { LOCAL_API_KEY } from "./api-key.local";

/** Resolve API key: UI field → api-key.local.ts → Vite env. */
export function resolveApiKey(uiValue?: string): string | undefined {
  const fromUi = uiValue?.trim();
  if (fromUi) return fromUi;
  const fromFile = (LOCAL_API_KEY ?? "").trim();
  if (fromFile) return fromFile;
  const fromEnv = String(
    (import.meta as ImportMeta & { env: Record<string, string> }).env
      ?.VITE_OPENAI_API_KEY ?? "",
  ).trim();
  if (fromEnv) return fromEnv;
  return undefined;
}

export function apiKeySource(uiValue?: string): "ui" | "file" | "env" | "none" {
  if (uiValue?.trim()) return "ui";
  if ((LOCAL_API_KEY ?? "").trim()) return "file";
  const fromEnv = String(
    (import.meta as ImportMeta & { env: Record<string, string> }).env
      ?.VITE_OPENAI_API_KEY ?? "",
  ).trim();
  if (fromEnv) return "env";
  return "none";
}
