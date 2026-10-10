interface SpeechAlt {
  transcript: string;
}

interface SpeechResult {
  isFinal: boolean;
  0: SpeechAlt;
}

interface SpeechEvent {
  resultIndex: number;
  results: ArrayLike<SpeechResult>;
}

interface SpeechRec extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onresult: ((ev: SpeechEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((ev: { error: string }) => void) | null;
}

type RecCtor = new () => SpeechRec;

function ctor(): RecCtor | null {
  const w = window as unknown as { SpeechRecognition?: RecCtor; webkitSpeechRecognition?: RecCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function speechSupported(): boolean {
  return ctor() !== null;
}

export interface RadioHandle {
  toggle(): void;
  stop(): void;
  readonly live: boolean;
}

export function createRadio(opts: {
  onFinal: (text: string) => void;
  onInterim: (text: string) => void;
  onState: (live: boolean, hint: string) => void;
}): RadioHandle {
  const Ctor = ctor();
  let armed = false;
  let rec: SpeechRec | null = null;

  const set = (live: boolean, hint: string) => opts.onState(live, hint);

  if (!Ctor) {
    set(false, 'Speech recognition unavailable in this browser — type orders.');
    return {
      toggle() {
        set(false, 'Speech recognition unavailable in this browser — type orders.');
      },
      stop() {},
      get live() {
        return false;
      },
    };
  }

  const boot = () => {
    rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = 'en-US';
    rec.onresult = (ev) => {
      let interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const row = ev.results[i];
        if (!row) continue;
        const text = row[0]?.transcript?.trim() ?? '';
        if (!text) continue;
        if (row.isFinal) opts.onFinal(text);
        else interim += text;
      }
      if (interim) opts.onInterim(interim);
    };
    rec.onerror = (ev) => {
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
        armed = false;
        set(false, 'Mic blocked — type orders instead.');
        return;
      }
      if (ev.error === 'aborted') return;
      set(armed, armed ? 'Radio: LIVE' : '');
    };
    rec.onend = () => {
      if (!armed) {
        set(false, '');
        return;
      }
      try {
        rec?.start();
      } catch {
        armed = false;
        set(false, 'Radio dropped — press Radio to retry.');
      }
    };
    try {
      rec.start();
      set(true, '');
    } catch {
      armed = false;
      set(false, 'Could not start the mic — type orders.');
    }
  };

  return {
    toggle() {
      if (armed) {
        armed = false;
        try {
          rec?.stop();
        } catch {
          /* already stopped */
        }
        set(false, '');
        return;
      }
      armed = true;
      boot();
    },
    stop() {
      armed = false;
      try {
        rec?.stop();
      } catch {
        /* already stopped */
      }
      set(false, '');
    },
    get live() {
      return armed;
    },
  };
}
