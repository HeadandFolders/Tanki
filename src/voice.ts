/** Browser speech recognition → order text. Chrome / Edge (webkit). */

export type VoiceStatus =
  | "unsupported"
  | "idle"
  | "listening"
  | "error";

type SpeechRec = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((ev: SpeechResultEvent) => void) | null;
  onerror: ((ev: { error: string }) => void) | null;
  onend: (() => void) | null;
};

type SpeechResultEvent = {
  resultIndex: number;
  results: ArrayLike<{
    isFinal: boolean;
    0: { transcript: string };
  }>;
};

function getSpeechRecognitionCtor(): (new () => SpeechRec) | null {
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRec;
    webkitSpeechRecognition?: new () => SpeechRec;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function voiceSupported(): boolean {
  return getSpeechRecognitionCtor() !== null;
}

export function explainVoiceError(code: string): string {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "Mic blocked — allow microphone for this site, or use phrase buttons / typing";
    case "audio-capture":
    case "no-mic":
      return "No microphone on this machine (Try Live VM often has none) — use phrase buttons";
    case "network":
      return "Speech service network error — try again, or use phrase buttons / typing";
    case "not-supported":
      return "Voice needs Chrome or Edge";
    case "aborted":
    case "no-speech":
      return "No speech heard — click Radio and speak again";
    default:
      return `Voice error: ${code} — use phrase buttons or type an order`;
  }
}

async function preflightMic(): Promise<{ ok: true } | { ok: false; code: string }> {
  if (!navigator.mediaDevices?.getUserMedia) {
    return { ok: false, code: "not-supported" };
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    return { ok: true };
  } catch (err) {
    const name = err instanceof DOMException ? err.name : "";
    if (name === "NotAllowedError" || name === "PermissionDeniedError") {
      return { ok: false, code: "not-allowed" };
    }
    if (
      name === "NotFoundError" ||
      name === "DevicesNotFoundError" ||
      name === "OverconstrainedError"
    ) {
      return { ok: false, code: "no-mic" };
    }
    if (name === "NotReadableError") return { ok: false, code: "audio-capture" };
    return { ok: false, code: name || "audio-capture" };
  }
}

export interface VoiceRadio {
  status: VoiceStatus;
  lastHeard: string;
  start: () => Promise<void>;
  stop: () => void;
  toggle: () => Promise<void>;
  destroy: () => void;
}

export function createVoiceRadio(opts: {
  onOrder: (text: string, segmentId?: string) => void;
  onStatus: (status: VoiceStatus, detail?: string) => void;
  lang?: string;
}): VoiceRadio {
  const Ctor = getSpeechRecognitionCtor();
  if (!Ctor) {
    opts.onStatus("unsupported", explainVoiceError("not-supported"));
    return {
      status: "unsupported",
      lastHeard: "",
      async start() {},
      stop() {},
      async toggle() {},
      destroy() {},
    };
  }

  let rec: SpeechRec | null = null;
  let wantListen = false;
  let status: VoiceStatus = "idle";
  let lastHeard = "";
  let restartTimer: number | null = null;
  let starting = false;
  const radioId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  let recognitionSession = 0;

  const setStatus = (s: VoiceStatus, detail?: string) => {
    status = s;
    opts.onStatus(s, detail);
  };

  const wire = (r: SpeechRec) => {
    const sessionId = `${radioId}:${++recognitionSession}`;
    r.continuous = true;
    r.interimResults = true;
    r.lang = opts.lang ?? "en-US";

    r.onresult = (ev) => {
      if (!wantListen || rec !== r) return;
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const piece = ev.results[i]![0]!.transcript.trim();
        if (!piece) continue;
        if (ev.results[i]!.isFinal) {
          lastHeard = piece;
          opts.onOrder(piece, `${sessionId}:${i}`);
        } else {
          lastHeard = piece;
          opts.onStatus("listening", `… ${piece}`);
        }
      }
    };

    r.onerror = (ev) => {
      if (rec !== r) return;
      if (ev.error === "aborted" || ev.error === "no-speech") {
        // keep listening; Chrome often fires these between phrases
        if (wantListen) opts.onStatus("listening", "Listening — speak an order…");
        return;
      }
      // Chrome's cloud STT drops a "network" error every few sentences.
      // Treat it as a restart, not as Radio: off.
      if (ev.error === "network" || ev.error === "audio-capture") {
        if (wantListen) {
          opts.onStatus("listening", "Speech hiccup — still listening…");
          try {
            rec?.abort();
          } catch {
            /* onend restarts */
          }
          rec = null;
        }
        return;
      }
      wantListen = false;
      setStatus("error", explainVoiceError(ev.error));
    };

    r.onend = () => {
      if (rec !== null && rec !== r) return;
      if (wantListen) {
        if (restartTimer != null) window.clearTimeout(restartTimer);
        restartTimer = window.setTimeout(() => {
          if (!wantListen) return;
          try {
            // Result indexes restart at zero for each recognition run.
            rec = new Ctor();
            wire(rec);
            rec.start();
            setStatus("listening", "Listening — speak an order…");
          } catch {
            rec = null;
            if (restartTimer != null) window.clearTimeout(restartTimer);
            restartTimer = window.setTimeout(() => {
              if (!wantListen) return;
              try {
                rec = new Ctor();
                wire(rec);
                rec.start();
                setStatus("listening", "Listening — speak an order…");
              } catch {
                /* next onend or the user clicks Radio */
              }
            }, 600);
          }
        }, 250);
      } else if (status === "listening") {
        setStatus("idle");
      }
    };
  };

  const start = async () => {
    if (starting || wantListen) return;
    starting = true;
    setStatus("listening", "Checking microphone…");
    const mic = await preflightMic();
    if (!mic.ok) {
      starting = false;
      setStatus("error", explainVoiceError(mic.code));
      return;
    }

    if (!starting) return; // Stopped while awaiting microphone permission.
    wantListen = true;
    rec = new Ctor();
    wire(rec);
    try {
      rec.start();
      setStatus("listening", "Listening — speak an order…");
    } catch {
      setStatus("listening", "Listening — speak an order…");
    }
    starting = false;
  };

  const stop = () => {
    wantListen = false;
    starting = false;
    if (restartTimer != null) {
      window.clearTimeout(restartTimer);
      restartTimer = null;
    }
    try {
      rec?.abort();
    } catch {
      try {
        rec?.stop();
      } catch {
        /* ignore */
      }
    }
    setStatus("idle");
  };

  return {
    get status() {
      return status;
    },
    get lastHeard() {
      return lastHeard;
    },
    start,
    stop,
    async toggle() {
      if (wantListen || status === "listening") stop();
      else await start();
    },
    destroy() {
      stop();
      rec = null;
    },
  };
}
