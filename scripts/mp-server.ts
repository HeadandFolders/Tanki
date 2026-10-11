/**
 * LAN multiplayer relay for Fog of War.
 * Host browser is authoritative; this process only relays + rooms.
 *
 *   npm run mp
 *   listens on 0.0.0.0:4855
 */
import http from "node:http";
import os from "node:os";
import { WebSocketServer, type WebSocket } from "ws";
import { CONFIG } from "../src/config.ts";
import {
  decode,
  encode,
  type ClientMsg,
  type NetRole,
  type ServerMsg,
} from "../src/net/protocol.ts";

const PORT = CONFIG.net.port;

/** Prefer home Wi‑Fi (192.168 / 10) over docker/cloud (often 172.x). */
function lanIpRank(ip: string): number {
  if (ip.startsWith("192.168.")) return 0;
  if (ip.startsWith("10.")) return 1;
  if (ip.startsWith("172.")) return 3; // often cloud/docker — last
  return 2;
}

function lanIps(): string[] {
  const out: string[] = [];
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) {
    if (!list) continue;
    for (const n of list) {
      const family = String(n.family);
      if ((family === "IPv4" || family === "4") && !n.internal) {
        out.push(n.address);
      }
    }
  }
  out.sort((a, b) => lanIpRank(a) - lanIpRank(b) || a.localeCompare(b));
  return out.length ? out : ["127.0.0.1"];
}

function looksLikeCloudOnly(ips: string[]): boolean {
  const usable = ips.filter((ip) => ip !== "127.0.0.1");
  return usable.length > 0 && usable.every((ip) => ip.startsWith("172."));
}

interface Peer {
  id: string;
  ws: WebSocket;
  role: NetRole;
  room: string;
  ready: boolean;
}

interface Room {
  code: string;
  host?: Peer;
  guest?: Peer;
}

const rooms = new Map<string, Room>();
let peerSeq = 0;

function getRoom(code: string): Room {
  const key = code.toUpperCase();
  let r = rooms.get(key);
  if (!r) {
    r = { code: key };
    rooms.set(key, r);
  }
  return r;
}

function send(ws: WebSocket, msg: ServerMsg): void {
  if (ws.readyState === ws.OPEN) ws.send(encode(msg));
}

function broadcastLobby(room: Room): void {
  const msg: ServerMsg = {
    type: "lobby",
    hostReady: !!room.host?.ready,
    guestReady: !!room.guest?.ready,
    guestConnected: !!room.guest,
  };
  if (room.host) send(room.host.ws, msg);
  if (room.guest) send(room.guest.ws, msg);
}

function detach(peer: Peer): void {
  const room = rooms.get(peer.room);
  if (!room) return;
  if (room.host?.id === peer.id) room.host = undefined;
  if (room.guest?.id === peer.id) room.guest = undefined;
  broadcastLobby(room);
  if (!room.host && !room.guest) rooms.delete(peer.room);
}

const server = http.createServer((req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, port: PORT, lanIps: lanIps() }));
    return;
  }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end(
    `Fog of War multiplayer relay\nWS/HTTP :${PORT}\nLAN: ${lanIps().join(", ")}\n`,
  );
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  let peer: Peer | null = null;

  ws.on("message", (data) => {
    const msg = decode(String(data)) as ClientMsg | null;
    if (!msg || typeof msg !== "object" || !("type" in msg)) return;

    if (msg.type === "hello") {
      const role = msg.role;
      const room =
        (msg.room || CONFIG.net.defaultRoom).toUpperCase().slice(0, 8) ||
        CONFIG.net.defaultRoom;
      const r = getRoom(room);

      if (role === "host") {
        if (r.host && r.host.ws.readyState === r.host.ws.OPEN) {
          send(ws, { type: "error", message: "Room already has a host." });
          return;
        }
        peer = {
          id: `p-${++peerSeq}`,
          ws,
          role: "host",
          room,
          ready: false,
        };
        r.host = peer;
        send(ws, {
          type: "welcome",
          role: "host",
          team: "blue",
          room,
          port: PORT,
          lanIps: lanIps(),
          playerId: peer.id,
        });
        broadcastLobby(r);
        return;
      }

      if (!r.host) {
        send(ws, {
          type: "error",
          message: `No host in room ${room}. Host first, then join.`,
        });
        return;
      }
      if (r.guest && r.guest.ws.readyState === r.guest.ws.OPEN) {
        send(ws, { type: "error", message: "Room already has a guest." });
        return;
      }
      peer = {
        id: `p-${++peerSeq}`,
        ws,
        role: "guest",
        room,
        ready: false,
      };
      r.guest = peer;
      send(ws, {
        type: "welcome",
        role: "guest",
        team: "red",
        room,
        port: PORT,
        lanIps: lanIps(),
        playerId: peer.id,
      });
      broadcastLobby(r);
      return;
    }

    if (!peer) {
      send(ws, { type: "error", message: "Send hello first." });
      return;
    }
    const room = rooms.get(peer.room);
    if (!room) return;

    if (msg.type === "ready") {
      peer.ready = true;
      broadcastLobby(room);
      return;
    }

    if (msg.type === "start") {
      if (peer.role !== "host") {
        send(ws, { type: "error", message: "Only host can start." });
        return;
      }
      if (!room.guest) {
        send(ws, { type: "error", message: "Wait for a guest to join." });
        return;
      }
      const seed = (Date.now() ^ (Math.random() * 1e9)) >>> 0;
      const startMsg: ServerMsg = { type: "start", seed };
      if (room.host) send(room.host.ws, startMsg);
      if (room.guest) send(room.guest.ws, startMsg);
      return;
    }

    if (msg.type === "input" && peer.role === "guest" && room.host) {
      send(room.host.ws, { type: "peer-input", input: msg.input });
      return;
    }

    if (msg.type === "order" && peer.role === "guest" && room.host) {
      send(room.host.ws, { type: "peer-order", text: msg.text });
      return;
    }

    if (msg.type === "mark" && peer.role === "guest" && room.host) {
      send(room.host.ws, { type: "peer-mark", x: msg.x, y: msg.y });
      return;
    }

    if (msg.type === "state" && peer.role === "host" && room.guest) {
      send(room.guest.ws, { type: "state", state: msg.state });
      return;
    }

    if (msg.type === "ping") {
      send(ws, { type: "pong", t: msg.t });
    }
  });

  ws.on("close", () => {
    if (peer) detach(peer);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  const ips = lanIps();
  console.log(`[mp] Fog of War relay on 0.0.0.0:${PORT}  LAN: ${ips.join(", ")}`);
  console.log(`[mp] Guest opens http://<lan-ip>:4847 and joins the room.`);
  if (looksLikeCloudOnly(ips)) {
    console.warn(
      "[mp] Only 172.x addresses found — often a Cursor/cloud VM. Guests on home Wi‑Fi cannot reach this IP. Run npm run dev:mp on your home PC instead.",
    );
  }
});
