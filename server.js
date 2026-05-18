import express from "express";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT ?? 3000;
const TICK_RATE = 60;
const DT = 1 / TICK_RATE;
const FIELD = { width: 1200, height: 720, goalWidth: 190, goalDepth: 36 };
const PLAYER_RADIUS = 24;
const BALL_RADIUS = 15;
const MATCH_SECONDS = 90;
const ROOM_TTL_MS = 1000 * 60 * 30;
const COLORS = ["#ff345d", "#26d9ff", "#ffd166", "#8cff66", "#d786ff", "#ff8a3d"];
const POWERUPS = {
  turbo: { label: "Turbo", duration: 5 },
  cannon: { label: "Tiro canon", duration: 7 },
  freeze: { label: "Congelar", duration: 0 },
  magnet: { label: "Iman", duration: 5 }
};

const app = express();
app.use(express.static(join(__dirname, "public")));

const server = createServer(app);
const wss = new WebSocketServer({ server });
const rooms = new Map();

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const randomCode = () => {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 5 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
};
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const now = () => Date.now();

function makeRoom(hostId) {
  let code = randomCode();
  while (rooms.has(code)) code = randomCode();
  const room = {
    code,
    hostId,
    players: new Map(),
    sockets: new Map(),
    state: "lobby",
    score: { red: 0, blue: 0 },
    ball: { x: FIELD.width / 2, y: FIELD.height / 2, vx: 0, vy: 0, owner: null },
    remaining: MATCH_SECONDS,
    countdown: 0,
    goalFlash: null,
    powerups: [],
    nextPowerupAt: now() + 5000,
    updatedAt: now()
  };
  rooms.set(code, room);
  return room;
}

function spawnFor(player) {
  const lane = player.slot % 3;
  const y = FIELD.height * (0.3 + lane * 0.2);
  const redSlots = [FIELD.width * 0.25, FIELD.width * 0.33, FIELD.width * 0.18];
  const blueSlots = [FIELD.width * 0.75, FIELD.width * 0.67, FIELD.width * 0.82];
  return {
    x: player.team === "red" ? redSlots[lane] : blueSlots[lane],
    y
  };
}

function addPlayer(room, socket, name) {
  const id = crypto.randomUUID();
  const slot = room.players.size;
  const team = slot % 2 === 0 ? "red" : "blue";
  const player = {
    id,
    name: String(name || `Jugador ${slot + 1}`).slice(0, 16),
    team,
    slot,
    color: COLORS[slot % COLORS.length],
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    input: { up: false, down: false, left: false, right: false, shoot: false, sprint: false },
    stamina: 1,
    goals: 0,
    saves: 0,
    power: null,
    powerUntil: 0,
    frozen: 0
  };
  Object.assign(player, spawnFor(player));
  room.players.set(id, player);
  room.sockets.set(id, socket);
  socket.playerId = id;
  socket.roomCode = room.code;
  return player;
}

function resetKickoff(room, scoringTeam = null) {
  const kickoffVelocity = scoringTeam === "red" ? -180 : scoringTeam === "blue" ? 180 : 0;
  room.ball = { x: FIELD.width / 2, y: FIELD.height / 2, vx: kickoffVelocity, vy: 0, owner: null };
  for (const player of room.players.values()) {
    Object.assign(player, spawnFor(player), { vx: 0, vy: 0, frozen: 0 });
  }
}

function serializeRoom(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    state: room.state,
    score: room.score,
    remaining: Math.max(0, Math.ceil(room.remaining)),
    countdown: Math.ceil(room.countdown),
    goalFlash: room.goalFlash,
    field: FIELD,
    ball: room.ball,
    powerups: room.powerups,
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      team: p.team,
      color: p.color,
      x: p.x,
      y: p.y,
      vx: p.vx,
      vy: p.vy,
      stamina: p.stamina,
      goals: p.goals,
      power: p.power,
      powerLabel: p.power ? POWERUPS[p.power]?.label ?? p.power : null,
      powerRemaining: p.power ? Math.max(0, Math.ceil((p.powerUntil - now()) / 1000)) : 0,
      frozen: p.frozen
    }))
  };
}

function send(socket, type, payload = {}) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type, ...payload }));
}

function broadcast(room, type, payload = {}) {
  for (const socket of room.sockets.values()) send(socket, type, payload);
}

function startRoom(room) {
  if (room.players.size < 2 || room.state === "playing" || room.state === "countdown") return;
  room.state = "countdown";
  room.score = { red: 0, blue: 0 };
  room.remaining = MATCH_SECONDS;
  room.countdown = 3;
  room.powerups = [];
  room.goalFlash = null;
  for (const player of room.players.values()) {
    player.goals = 0;
    player.power = null;
    player.powerUntil = 0;
    player.stamina = 1;
  }
  resetKickoff(room);
}

function spawnPowerup(room) {
  if (room.powerups.length >= 3) return;
  const types = Object.keys(POWERUPS);
  room.powerups.push({
    id: crypto.randomUUID(),
    type: types[Math.floor(Math.random() * types.length)],
    label: null,
    x: FIELD.width * (0.25 + Math.random() * 0.5),
    y: FIELD.height * (0.18 + Math.random() * 0.64)
  });
  room.powerups.at(-1).label = POWERUPS[room.powerups.at(-1).type].label;
}

function clearExpiredPower(player) {
  if (player.power && player.powerUntil && now() >= player.powerUntil) {
    player.power = null;
    player.powerUntil = 0;
  }
}

function updatePlayer(player) {
  clearExpiredPower(player);
  if (player.frozen > 0) {
    player.frozen = Math.max(0, player.frozen - DT);
    player.vx *= 0.82;
    player.vy *= 0.82;
  } else {
    const ix = Number(player.input.right) - Number(player.input.left);
    const iy = Number(player.input.down) - Number(player.input.up);
    const len = Math.hypot(ix, iy) || 1;
    const sprinting = player.input.sprint && player.stamina > 0.08;
    const turbo = player.power === "turbo";
    const accel = sprinting || turbo ? 1240 : 820;
    const maxSpeed = sprinting || turbo ? 360 : 255;
    player.vx += (ix / len) * accel * DT;
    player.vy += (iy / len) * accel * DT;
    const speed = Math.hypot(player.vx, player.vy);
    if (speed > maxSpeed) {
      player.vx = (player.vx / speed) * maxSpeed;
      player.vy = (player.vy / speed) * maxSpeed;
    }
    player.stamina = clamp(player.stamina + (sprinting ? -0.42 : 0.22) * DT, 0, 1);
  }
  player.x += player.vx * DT;
  player.y += player.vy * DT;
  player.vx *= 0.88;
  player.vy *= 0.88;
  player.x = clamp(player.x, PLAYER_RADIUS, FIELD.width - PLAYER_RADIUS);
  player.y = clamp(player.y, PLAYER_RADIUS, FIELD.height - PLAYER_RADIUS);
}

function collidePlayers(room) {
  const players = [...room.players.values()];
  for (let i = 0; i < players.length; i += 1) {
    for (let j = i + 1; j < players.length; j += 1) {
      const a = players[i];
      const b = players[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 1;
      const min = PLAYER_RADIUS * 2;
      if (d >= min) continue;
      const push = (min - d) / 2;
      const nx = dx / d;
      const ny = dy / d;
      a.x -= nx * push;
      a.y -= ny * push;
      b.x += nx * push;
      b.y += ny * push;
      const bump = 65;
      a.vx -= nx * bump;
      a.vy -= ny * bump;
      b.vx += nx * bump;
      b.vy += ny * bump;
    }
  }
}

function updateBall(room) {
  const ball = room.ball;
  for (const player of room.players.values()) {
    if (player.power !== "magnet") continue;
    const d = distance(player, ball);
    if (d > 210 || d < PLAYER_RADIUS + BALL_RADIUS) continue;
    ball.vx += ((player.x - ball.x) / d) * 430 * DT;
    ball.vy += ((player.y - ball.y) / d) * 430 * DT;
  }
  for (const player of room.players.values()) {
    const d = distance(player, ball);
    const touch = PLAYER_RADIUS + BALL_RADIUS;
    if (d > touch) continue;
    const nx = (ball.x - player.x) / (d || 1);
    const ny = (ball.y - player.y) / (d || 1);
    ball.x = player.x + nx * touch;
    ball.y = player.y + ny * touch;
    const shootBoost = player.input.shoot ? (player.power === "cannon" ? 860 : 620) : 210;
    ball.vx = player.vx * 0.78 + nx * shootBoost;
    ball.vy = player.vy * 0.78 + ny * shootBoost;
    ball.owner = player.id;
    if (player.power === "cannon" && player.input.shoot) player.power = null;
    if (player.power === "cannon" && player.input.shoot) player.powerUntil = 0;
  }
  ball.x += ball.vx * DT;
  ball.y += ball.vy * DT;
  ball.vx *= 0.992;
  ball.vy *= 0.992;

  const goalTop = FIELD.height / 2 - FIELD.goalWidth / 2;
  const goalBottom = FIELD.height / 2 + FIELD.goalWidth / 2;
  const isInsideGoalMouth = ball.y > goalTop + BALL_RADIUS && ball.y < goalBottom - BALL_RADIUS;
  if (isInsideGoalMouth && ball.x <= FIELD.goalDepth + BALL_RADIUS) return scoreGoal(room, "blue");
  if (isInsideGoalMouth && ball.x >= FIELD.width - FIELD.goalDepth - BALL_RADIUS) return scoreGoal(room, "red");

  if (ball.x < BALL_RADIUS || ball.x > FIELD.width - BALL_RADIUS) {
    ball.x = clamp(ball.x, BALL_RADIUS, FIELD.width - BALL_RADIUS);
    ball.vx *= -0.84;
  }
  if (ball.y < BALL_RADIUS || ball.y > FIELD.height - BALL_RADIUS) {
    ball.y = clamp(ball.y, BALL_RADIUS, FIELD.height - BALL_RADIUS);
    ball.vy *= -0.84;
  }
  return null;
}

function scoreGoal(room, team) {
  room.score[team] += 1;
  const scorer = room.players.get(room.ball.owner);
  if (scorer?.team === team) scorer.goals += 1;
  room.goalFlash = { team, text: `GOL ${team === "red" ? "ROJO" : "AZUL"}!`, until: now() + 1700 };
  room.state = "goal";
  room.countdown = 1.7;
  room.powerups = [];
  resetKickoff(room, team);
}

function updatePowerups(room) {
  if (now() >= room.nextPowerupAt) {
    spawnPowerup(room);
    room.nextPowerupAt = now() + 6500 + Math.random() * 4500;
  }
  for (const player of room.players.values()) {
    const index = room.powerups.findIndex((p) => distance(player, p) < PLAYER_RADIUS + 18);
    if (index === -1) continue;
    const [powerup] = room.powerups.splice(index, 1);
    player.power = powerup.type;
    player.powerUntil = POWERUPS[powerup.type].duration ? now() + POWERUPS[powerup.type].duration * 1000 : 0;
    if (powerup.type === "freeze") {
      for (const rival of room.players.values()) {
        if (rival.team !== player.team) rival.frozen = 1.25;
      }
      player.power = null;
      player.powerUntil = 0;
    }
  }
}

function tickRoom(room) {
  room.updatedAt = now();
  if (room.goalFlash?.until < now()) room.goalFlash = null;
  if (room.state === "countdown") {
    room.countdown -= DT;
    if (room.countdown <= 0) room.state = "playing";
  } else if (room.state === "goal") {
    room.countdown -= DT;
    if (room.countdown <= 0) room.state = "playing";
  } else if (room.state === "playing") {
    room.remaining -= DT;
    for (const player of room.players.values()) updatePlayer(player);
    collidePlayers(room);
    updateBall(room);
    updatePowerups(room);
    if (room.remaining <= 0) room.state = "finished";
  }
  broadcast(room, "state", { room: serializeRoom(room) });
}

function cleanupRooms() {
  for (const [code, room] of rooms.entries()) {
    if (room.players.size === 0 && now() - room.updatedAt > ROOM_TTL_MS) rooms.delete(code);
  }
}

wss.on("connection", (socket) => {
  send(socket, "hello", { message: "connected" });
  socket.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      send(socket, "error", { message: "Mensaje invalido" });
      return;
    }
    if (message.type === "create") {
      const room = makeRoom(null);
      const player = addPlayer(room, socket, message.name);
      room.hostId = player.id;
      send(socket, "joined", { playerId: player.id, room: serializeRoom(room) });
      broadcast(room, "state", { room: serializeRoom(room) });
      return;
    }
    if (message.type === "join") {
      const code = String(message.code ?? "").trim().toUpperCase();
      const room = rooms.get(code);
      if (!room) return send(socket, "error", { message: "Sala no encontrada" });
      if (room.players.size >= 6) return send(socket, "error", { message: "Sala llena" });
      if (room.state !== "lobby" && room.state !== "finished") return send(socket, "error", { message: "La partida ya empezo" });
      const player = addPlayer(room, socket, message.name);
      send(socket, "joined", { playerId: player.id, room: serializeRoom(room) });
      broadcast(room, "state", { room: serializeRoom(room) });
      return;
    }
    const room = rooms.get(socket.roomCode);
    const player = room?.players.get(socket.playerId);
    if (!room || !player) return;
    if (message.type === "input") {
      player.input = {
        up: Boolean(message.input?.up),
        down: Boolean(message.input?.down),
        left: Boolean(message.input?.left),
        right: Boolean(message.input?.right),
        shoot: Boolean(message.input?.shoot),
        sprint: Boolean(message.input?.sprint)
      };
    }
    if (message.type === "start" && socket.playerId === room.hostId) startRoom(room);
  });

  socket.on("close", () => {
    const room = rooms.get(socket.roomCode);
    if (!room) return;
    room.players.delete(socket.playerId);
    room.sockets.delete(socket.playerId);
    if (room.hostId === socket.playerId) room.hostId = room.players.keys().next().value ?? null;
    if (room.players.size < 2 && room.state === "playing") room.state = "lobby";
    broadcast(room, "state", { room: serializeRoom(room) });
  });
});

setInterval(() => {
  for (const room of rooms.values()) tickRoom(room);
}, 1000 / TICK_RATE);
setInterval(cleanupRooms, 60_000);

server.listen(PORT, () => {
  console.log(`Derbi Relampago escuchando en http://localhost:${PORT}`);
});
