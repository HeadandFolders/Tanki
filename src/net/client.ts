import { CONFIG } from "../config";
import {
  decode,
  encode,
  type ClientMsg,
  type NetInput,
  type NetRole,
  type NetStateSnap,
  type NetTeam,
  type ServerMsg,
} from "./protocol";

export type NetStatus =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "connected"; role: NetRole; team: NetTeam; room: string }
  | { kind: "lobby"; role: NetRole; team: NetTeam; room: string; guestConnected: boolean }
  | { kind: "error"; message: string };

export interface NetClientHandlers {
  onStatus: (s: NetStatus) => void;
  onStart: (seed: number) => void;
  onState: (state: NetStateSnap) => void;
  onPeerInput: (input: NetInput) => void;
  onPeerOrder: (text: string) => void;
  onPeerMark: (x: number, y: number) => void;
  onLog?: (line: string) => void;
}

export class NetClient {
  private ws: WebSocket | null = null;
  private role: NetRole | null = null;
  private team: NetTeam | null = null;
  private room: string = CONFIG.net.defaultRoom;
  private lanIps: string[] = [];
  private port: number = CONFIG.net.port;
  handlers: NetClientHandlers;

  constructor(handlers: NetClientHandlers) {
    this.handlers = handlers;
  }

  get info() {
    return {
      role: this.role,
      team: this.team,
      room: this.room,
      lanIps: this.lanIps,
      port: this.port,
      connected: !!this.ws && this.ws.readyState === WebSocket.OPEN,
    };
  }

  /** Default WS URL: same host as the page, uncommon MP port. */
  static defaultUrl(port = CONFIG.net.port): string {
    const host = location.hostname || "127.0.0.1";
    const proto = location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${host}:${port}`;
  }

  connect(opts: {
    role: NetRole;
    room?: string;
    url?: string;
  }): void {
    this.disconnect();
    this.role = opts.role;
    this.room = (opts.room || CONFIG.net.defaultRoom).toUpperCase();
    const url = opts.url || NetClient.defaultUrl();
    this.handlers.onStatus({ kind: "connecting" });
    this.handlers.onLog?.(`Connecting ${opts.role} → ${url} room ${this.room}`);

    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.send({
        type: "hello",
        role: opts.role,
        room: this.room,
      });
    };

    ws.onmessage = (ev) => {
      const msg = decode(String(ev.data)) as ServerMsg | null;
      if (!msg) return;
      this.handleServer(msg);
    };

    ws.onerror = () => {
      this.handlers.onStatus({
        kind: "error",
        message: `WebSocket error — is the relay running on port ${this.port}? (npm run mp)`,
      });
    };

    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      this.handlers.onLog?.("Disconnected from relay.");
    };
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.role = null;
    this.team = null;
  }

  sendReady(): void {
    this.send({ type: "ready" });
  }

  sendStart(): void {
    this.send({ type: "start" });
  }

  sendInput(input: NetInput): void {
    this.send({ type: "input", input });
  }

  sendOrder(text: string): void {
    this.send({ type: "order", text });
  }

  sendMark(x: number, y: number): void {
    this.send({ type: "mark", x, y });
  }

  sendState(state: NetStateSnap): void {
    this.send({ type: "state", state });
  }

  private send(msg: ClientMsg): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(encode(msg));
  }

  private handleServer(msg: ServerMsg): void {
    switch (msg.type) {
      case "welcome":
        this.role = msg.role;
        this.team = msg.team;
        this.room = msg.room;
        this.port = msg.port;
        this.lanIps = msg.lanIps;
        this.handlers.onStatus({
          kind: "connected",
          role: msg.role,
          team: msg.team,
          room: msg.room,
        });
        this.handlers.onLog?.(
          `Joined as ${msg.role} (${msg.team}) room ${msg.room}. LAN: ${msg.lanIps.join(", ")}:${msg.port}`,
        );
        break;
      case "lobby":
        if (this.role && this.team) {
          this.handlers.onStatus({
            kind: "lobby",
            role: this.role,
            team: this.team,
            room: this.room,
            guestConnected: msg.guestConnected,
          });
        }
        break;
      case "start":
        this.handlers.onStart(msg.seed);
        break;
      case "state":
        this.handlers.onState(msg.state);
        break;
      case "peer-input":
        this.handlers.onPeerInput(msg.input);
        break;
      case "peer-order":
        this.handlers.onPeerOrder(msg.text);
        break;
      case "peer-mark":
        this.handlers.onPeerMark(msg.x, msg.y);
        break;
      case "error":
        this.handlers.onStatus({ kind: "error", message: msg.message });
        this.handlers.onLog?.(msg.message);
        break;
      default:
        break;
    }
  }
}
