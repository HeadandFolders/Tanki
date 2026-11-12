import {
  POSTMORTEM_KEY,
  readPostmortem,
  type PostmortemEntry,
} from "./command-history";

const rowsEl = document.querySelector<HTMLTableSectionElement>("#rows")!;
const countEl = document.querySelector<HTMLElement>("#count")!;

function jannaLabel(e: PostmortemEntry): string {
  if (e.source === "ai_commander") return "not scored";
  if (e.jannaEval === "pass") return "pass";
  if (e.jannaEval === "fail") return "fail";
  return "—";
}

export function postmortemLine(e: PostmortemEntry): string {
  const when = e.at.replace("T", " ").replace(/\.\d+Z$/, "Z");
  const goals = e.goals.length ? e.goals.join("; ") : "-";
  const reason = e.reason ? `  reason=${e.reason} seed=${e.seed} t=${e.issuedAt}` : "";
  return `${when}  ${e.mode}  ${e.team}  "${e.text}"  ->  ${e.handler}  [${jannaLabel(e)}]  (${goals})${reason}`;
}

function cell(text: string, className?: string): HTMLTableCellElement {
  const td = document.createElement("td");
  td.textContent = text;
  if (className) td.className = className;
  return td;
}

function render(): void {
  const entries = readPostmortem();
  countEl.textContent = `${entries.length} command(s)`;
  rowsEl.replaceChildren();
  if (!entries.length) {
    const tr = document.createElement("tr");
    const td = cell("No commands logged yet.", "empty");
    td.colSpan = 8;
    tr.appendChild(td);
    rowsEl.appendChild(tr);
    return;
  }
  for (const e of [...entries].reverse()) {
    const tr = document.createElement("tr");
    tr.append(
      cell(new Date(e.at).toLocaleString()),
      cell(e.mode),
      cell(e.team),
      cell(e.text),
      cell(e.handler, `handler-${e.handler.toLowerCase()}`),
      cell(jannaLabel(e), e.jannaEval ? `janna-${e.jannaEval}` : "janna-none"),
      cell(e.goals.join("; ") || "-"),
      cell(String(e.ms)),
    );
    rowsEl.appendChild(tr);
  }
}

document.querySelector("#download")!.addEventListener("click", () => {
  const text = readPostmortem().map(postmortemLine).join("\n") + "\n";
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `command-postmortem-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

document.querySelector("#clear")!.addEventListener("click", () => {
  if (!confirm("Clear the saved command log in this browser?")) return;
  localStorage.removeItem(POSTMORTEM_KEY);
  render();
});

window.addEventListener("storage", (ev) => {
  if (ev.key === POSTMORTEM_KEY) render();
});

render();
