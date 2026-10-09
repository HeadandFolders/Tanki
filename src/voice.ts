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

export interface VoiceRadio {
  status: VoiceStatus;
  lastHeard: string;
  start: () => void;
  stop: () => void;
  toggle: () => void;
  destroy: () => void;
}

export function createVoiceRadio(opts: {
  onFinalOrder: (text: string) => void;
  onStatus: (status: VoiceStatus, detail?: string) => void;
  lang?: string;
}): VoiceRadio {
  const Ctor = getSpeechRecognitionCtor();
  if (!Ctor) {
    opts.onStatus("unsupported", "Speech recognition not available in this browser");
    return {
      status: "unsupported",
      lastHeard: "",
      start() {},
      stop() {},
      toggle() {},
      destroy() {},
    };
  }

  let rec: SpeechRec | null = null;
  let wantListen = false;
  let status: VoiceStatus = "idle";
  let lastHeard = "";
  let restartTimer: number | null = null;

  const setStatus = (s: VoiceStatus, detail?: string) => {
    status = s;
    opts.onStatus(s, detail);
  };

  const wire = (r: SpeechRec) => {
    r.continuous = true;
    r.interimResults = true;
    r.lang = opts.lang ?? "en-US";

    r.onresult = (ev) => {
      let interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const piece = ev.results[i]![0]!.transcript.trim();
        if (!piece) continue;
        if (ev.results[i]!.isFinal) {
          lastHeard = piece;
          opts.onFinalOrder(piece);
        } else {
          interim = piece;
          lastHeard = interim;
          opts.onStatus("listening", `… ${interim}`);
        }
      }
    };

    r.onerror = (ev) => {
      if (ev.error === "aborted" || ev.error === "no-speech") {
        // benign — keep trying if still armed
        return;
      }
      setStatus("error", ev.error);
      wantListen = false;
    };

    r.onend = () => {
      if (wantListen) {
        // Chrome stops after pauses; auto-restart while radio is live
        if (restartTimer != null) window.clearTimeout(restartTimer);
        restartTimer = window.setTimeout(() => {
          if (!wantListen) return;
          try {
            r.start();
            setStatus("listening");
          } catch {
            /* already started */
          }
        }, 200);
      } else if (status !== "error" && status !== "unsupported") {
        setStatus("idle");
      }
    };
  };

  const start = () => {
    wantListen = true;
    if (!rec) {
      rec = new Ctor();
      wire(rec);
    }
    try {
      rec.start();
      setStatus("listening");
    } catch {
      // InvalidStateError if already started
      setStatus("listening");
    }
  };

  const stop = () => {
    wantListen = false;
    if (restartTimer != null) {
      window.clearTimeout(restartTimer);
      restartTimer = null;
    }
    try {
      rec?.stop();
    } catch {
      /* ignore */
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
    toggle() {
      if (wantListen) stop();
      else start();
    },
    destroy() {
      stop();
      rec = null;
    },
  };
}
