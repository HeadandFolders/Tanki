/**
 * Load Needle in a browser worker. Imported dynamically, so the package and
 * its 35 MB model are fetched only when the sidecar is switched on.
 */
import {
  NEEDLE_SYSTEM,
  needleToolOptions,
  setNeedleEngine,
  setNeedleEngineLoading,
  type NeedleRawResult,
} from "./needle-sidecar";

export async function loadBrowserNeedle(
  onProgress?: (percent: number | null) => void,
): Promise<void> {
  setNeedleEngineLoading();
  try {
    const mod = await import("cactus-needle/browser");
    const opts = needleToolOptions();
    const tools = {
      attack: mod.tool(opts.attack),
      cover: mod.tool(opts.cover),
      move_to: mod.tool(opts.move_to),
      flank: mod.tool(opts.flank),
      surround: mod.tool(opts.surround),
    };
    const needle = await mod.createNeedle({
      tools,
      stateless: true,
      system: NEEDLE_SYSTEM,
      maxOutputTokens: 128,
      onDownloadProgress: (p) => onProgress?.(p.percentage ?? null),
    });
    await needle.complete("1 attack 2");
    setNeedleEngine({
      complete: async (text) => (await needle.complete(text)) as NeedleRawResult,
    });
  } catch (err) {
    setNeedleEngine(null, err instanceof Error ? err.message : String(err));
    throw err;
  }
}
