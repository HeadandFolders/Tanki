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
  onFinalOrder: (text: string) => void;
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

  const setStatus = (s: VoiceStatus, detail?: string) => {
    status = s;
    opts.onStatus(s, detail);
  };

  const wire = (r: SpeechRec) => {
    r.continuous = true;
    r.interimResults = true;
    r.lang = opts.lang ?? "en-US";

    r.onresult = (ev) => {
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const piece = ev.results[i]![0]!.transcript.trim();
        if (!piece) continue;
        if (ev.results[i]!.isFinal) {
          lastHeard = piece;
          opts.onFinalOrder(piece);
        } else {
          lastHeard = piece;
          opts.onStatus("listening", `… ${piece}`);
        }
      }
    };

    r.onerror = (ev) => {
      if (ev.error === "aborted") return;
      if (ev.error === "no-speech") {
        // keep listening; Chrome often fires this between phrases
        opts.onStatus("listening", "Listening — speak an order…");
        return;
      }
      wantListen = false;
      setStatus("error", explainVoiceError(ev.error));
    };

    r.onend = () => {
      if (wantListen) {
        if (restartTimer != null) window.clearTimeout(restartTimer);
        restartTimer = window.setTimeout(() => {
          if (!wantListen || !rec) return;
          try {
            rec.start();
            setStatus("listening", "Listening — speak an order…");
          } catch {
            /* already started */
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

    wantListen = true;
    if (!rec) {
      rec = new Ctor();
      wire(rec);
    }
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
