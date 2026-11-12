/**
 * Debug overlay: the last radio sentences, one colored line each, tagged with
 * the parser that handled them. ` toggles it; Shift+` dumps the comparison log.
 */
import { CONFIG } from "./config";
import {
  commandLog,
  describeNeedleReading,
  onCommandRecord,
  type CommandRecord,
} from "./command-pipeline";
import { needleEngineState, needleSidecarEnabled } from "./needle-sidecar";

const COLORS: Record<CommandRecord["which_path_executed"], string> = {
  phrase_reader: "#5fd35f",
  needle: "#f0b030",
  llm_api: "#5aa8ff",
  ai_commander: "#e58bff",
  none: "#9a9a9a",
};

function lineFor(rec: CommandRecord): string {
  const src = rec.which_path_executed;
  const goals = rec.goals.length ? rec.goals.join("; ") : "(no goal)";
  const n = rec.needle_result;
  let tag: string = src;
  if (src === "needle") tag = `needle ${n?.confidence?.toFixed(2) ?? "?"}`;
  else if (src === "llm_api") tag = `llm_api ${rec.llm_result.ms ?? "?"}ms`;
  else if (src === "phrase_reader" && !rec.fast_path_result.settled) {
    tag = "phrase_reader·keyword guess";
  }
  const team = rec.team === "red" ? " (red)" : "";
  let line = `[${tag}]${team} ${rec.raw_text} → ${goals}`;
  if (src === "none" && rec.notice) line += ` — ${rec.notice}`;
  if (rec.sidecar && n && src !== "needle" && n.status !== "skipped_fast_path") {
    const conf = n.confidence != null ? ` ${n.confidence.toFixed(2)}` : "";
    const ms = n.ms != null ? ` ${n.ms}ms` : "";
    const reading = describeNeedleReading(n);
    line += `   · needle ${n.late ? "late " : ""}${n.status}${conf}${ms}${reading ? `: ${reading}` : ""}`;
  }
  return line;
}

export function mountCommandOverlay(host: HTMLElement): void {
  const box = document.createElement("div");
  box.className = "command-overlay";
  box.hidden = true;
  host.appendChild(box);

  const render = () => {
    if (box.hidden) return;
    const recent = commandLog().slice(-CONFIG.needle.overlaySize);
    box.replaceChildren();
    const head = document.createElement("div");
    head.className = "command-overlay-head";
    head.textContent = needleSidecarEnabled()
      ? `Command sources · needle sidecar ON (${needleEngineState()}) · Shift+\` dumps log`
      : "Command sources · needle sidecar off · Shift+` dumps log";
    box.appendChild(head);
    for (const rec of recent) {
      const row = document.createElement("div");
      row.style.color = COLORS[rec.which_path_executed];
      row.textContent = lineFor(rec);
      box.appendChild(row);
    }
  };

  onCommandRecord(render);

  window.addEventListener("keydown", (ev) => {
    if (ev.code !== "Backquote") return;
    const tag = (ev.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    ev.preventDefault();
    if (ev.shiftKey) {
      dumpCommandLog();
      return;
    }
    box.hidden = !box.hidden;
    render();
  });
}

/** Last N comparison records to the console and a JSON download. */
export function dumpCommandLog(n: number = CONFIG.needle.logSize): void {
  const rows = commandLog().slice(-n);
  console.table(
    rows.map((r) => ({
      raw_text: r.raw_text,
      path: r.which_path_executed,
      fast_path: r.fast_path_result.reading ?? "-",
      needle: r.needle_result
        ? `${r.needle_result.status}${r.needle_result.confidence != null ? ` ${r.needle_result.confidence.toFixed(2)}` : ""}`
        : "-",
      needle_ms: r.needle_result?.ms ?? "-",
      llm: r.llm_result.attempted ? (r.llm_result.reading ?? r.llm_result.error ?? "no answer") : "-",
      llm_ms: r.llm_result.ms ?? "-",
      goals: r.goals.join("; "),
      latency_ms: r.latency_ms,
      to_goal_ms: r.command_to_goal_ms,
      t_ack_ms: r.t_ack_ms,
      repeat_count: r.repeat_count,
      interrupts: r.interrupts,
      died_stuck: r.died_stuck,
    })),
  );
  const blob = new Blob([JSON.stringify(rows, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `command-log-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
