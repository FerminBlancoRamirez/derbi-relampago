const canvas = document.querySelector("#field");
const ctx = canvas.getContext("2d");
const menu = document.querySelector("#menu");
const game = document.querySelector("#game");
const statusEl = document.querySelector("#status");
const overlay = document.querySelector("#overlay");
const roster = document.querySelector("#roster");
const startButton = document.querySelector("#startMatch");
const copyInviteButton = document.querySelector("#copyInvite");
const createButton = document.querySelector("#createRoom");
const joinButton = document.querySelector("#joinRoom");
const roomCodeInput = document.querySelector("#roomCode");
const playerNameInput = document.querySelector("#playerName");
const serverUrlInput = document.querySelector("#serverUrl");
const redScore = document.querySelector("#redScore");
const blueScore = document.querySelector("#blueScore");
const timer = document.querySelector("#timer");
const roomLabel = document.querySelector("#roomLabel");
const phaseTitle = document.querySelector("#phaseTitle");
const phaseText = document.querySelector("#phaseText");

const DEFAULT_RENDER_WS = "wss://derbi-relampago.onrender.com";
const OLD_RENDER_WS = "wss://derbi-relampago-server.onrender.com";
const keys = new Set();
let socket = null;
let playerId = null;
let room = null;
let lastInput = "";
let currentServerUrl = "";

function resolveServerUrl() {
  const params = new URLSearchParams(location.search);
  const explicit = params.get("server") || serverUrlInput.value.trim() || localStorage.getItem("derbiServer");
  const normalized = normalizeServerUrl(explicit);
  if (normalized) return normalized;
  if (location.hostname === "localhost" || location.hostname === "127.0.0.1") return `ws://${location.host}`;
  return DEFAULT_RENDER_WS;
}

function normalizeServerUrl(value) {
  if (!value) return "";
  const normalized = value.trim().replace(/^http:/, "ws:").replace(/^https:/, "wss:").replace(/\/$/, "");
  if (normalized === OLD_RENDER_WS) {
    localStorage.removeItem("derbiServer");
    return DEFAULT_RENDER_WS;
  }
  return normalized;
}

function setStatus(text) { statusEl.textContent = text; }

function connect() {
  return new Promise((resolve, reject) => {
    if (socket?.readyState === WebSocket.OPEN) return resolve(socket);
    const url = resolveServerUrl();
    currentServerUrl = url;
    serverUrlInput.value = url;
    localStorage.setItem("derbiServer", url);
    socket = new WebSocket(url);
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener("error", () => reject(new Error(`No se pudo conectar a ${url}`)), { once: true });
    socket.addEventListener("message", handleMessage);
    socket.addEventListener("close", () => setStatus(`Conexion cerrada con ${currentServerUrl}. Revisa que Render este desplegado como Web Service y usa su URL wss://...`));
  });
}

function send(type, payload = {}) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type, ...payload }));
}

async function createRoom() {
  try {
    setStatus("Conectando...");
    await connect();
    send("create", { name: playerNameInput.value });
  } catch (error) {
    setStatus(error.message);
  }
}

async function joinRoom() {
  try {
    setStatus("Entrando en sala...");
    await connect();
    send("join", { code: roomCodeInput.value, name: playerNameInput.value });
  } catch (error) {
    setStatus(error.message);
  }
}

function handleMessage(event) {
  const message = JSON.parse(event.data);
  if (message.type === "error") setStatus(message.message);
  if (message.type === "joined") {
    playerId = message.playerId;
    room = message.room;
    menu.classList.add("hidden");
    game.classList.remove("hidden");
    roomCodeInput.value = room.code;
    history.replaceState(null, "", `?room=${room.code}`);
    updateUi();
  }
  if (message.type === "state") {
    room = message.room;
    updateUi();
  }
}

function buildInput() {
  return {
    up: keys.has("KeyW") || keys.has("ArrowUp"),
    down: keys.has("KeyS") || keys.has("ArrowDown"),
    left: keys.has("KeyA") || keys.has("ArrowLeft"),
    right: keys.has("KeyD") || keys.has("ArrowRight"),
    shoot: keys.has("Space"),
    sprint: keys.has("ShiftLeft") || keys.has("ShiftRight")
  };
}

function sendInput() {
  if (!playerId) return;
  const input = buildInput();
  const encoded = JSON.stringify(input);
  if (encoded !== lastInput) {
    lastInput = encoded;
    send("input", { input });
  }
}

function updateUi() {
  if (!room) return;
  redScore.textContent = room.score.red;
  blueScore.textContent = room.score.blue;
  timer.textContent = room.remaining;
  roomLabel.textContent = `Sala ${room.code}`;
  const me = room.players.find((p) => p.id === playerId);
  const isHost = room.hostId === playerId;
  copyInviteButton.classList.remove("hidden");
  startButton.classList.toggle("hidden", !isHost || room.players.length < 2 || !["lobby", "finished"].includes(room.state));
  phaseTitle.textContent = ({ lobby: "Lobby", countdown: "Calentando", playing: "Partido", goal: "Gol", finished: "Final" })[room.state] ?? "Sala";
  phaseText.textContent = getPhaseText(me);
  roster.innerHTML = room.players.map((p) => `<div class="player-row"><b style="color:${p.color}">${p.name}${p.id === playerId ? " (tu)" : ""}</b><span>${p.team.toUpperCase()} · ${p.goals} goles</span></div>`).join("");
  overlay.textContent = room.goalFlash?.text ?? (room.state === "countdown" ? room.countdown : room.state === "finished" ? winnerText() : "");
}

async function copyInvite() {
  if (!room) return;
  const server = encodeURIComponent(resolveServerUrl());
  const url = `${location.origin}${location.pathname}?room=${room.code}&server=${server}`;
  try {
    await navigator.clipboard.writeText(url);
    phaseText.textContent = "Invitacion copiada. Envia ese enlace a tus amigos.";
  } catch {
    phaseText.textContent = `Enlace: ${url}`;
  }
}

function getPhaseText(me) {
  if (!room) return "";
  if (room.state === "lobby") return `Comparte el codigo ${room.code}. Minimo 2 jugadores.`;
  if (room.state === "countdown") return "Preparate para el saque inicial.";
  if (room.state === "playing") return `${me?.power ? `Estrella: ${me.powerLabel} ${me.powerRemaining}s. ` : ""}Empuja, roba y dispara.`;
  if (room.state === "finished") return winnerText();
  return "Celebracion rapida y seguimos.";
}

function winnerText() {
  if (!room) return "";
  if (room.score.red === room.score.blue) return "Empate salvaje";
  return room.score.red > room.score.blue ? "Gana Rojo" : "Gana Azul";
}

function drawField(field) {
  const { width, height, goalWidth } = field;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const stripe = width / 10;
  for (let i = 0; i < 10; i += 1) {
    ctx.fillStyle = i % 2 ? "#0e3a20" : "#124825";
    ctx.fillRect(i * stripe, 0, stripe, height);
  }
  ctx.strokeStyle = "rgba(248,255,232,.62)";
  ctx.lineWidth = 5;
  ctx.strokeRect(34, 34, width - 68, height - 68);
  ctx.beginPath();
  ctx.moveTo(width / 2, 34);
  ctx.lineTo(width / 2, height - 34);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(width / 2, height / 2, 92, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,.08)";
  ctx.fillRect(0, height / 2 - goalWidth / 2, 42, goalWidth);
  ctx.fillRect(width - 42, height / 2 - goalWidth / 2, 42, goalWidth);
}

function drawPlayer(player) {
  if (player.power) {
    const pulse = 30 + Math.sin(performance.now() / 120) * 7;
    ctx.fillStyle = powerColor(player.power, 0.22);
    ctx.beginPath();
    ctx.arc(player.x, player.y, pulse, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = powerColor(player.power, 0.8);
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(player.x, player.y, pulse + 5, 0, Math.PI * 2);
    ctx.stroke();
  }
  if (player.frozen > 0) {
    ctx.strokeStyle = "rgba(38,217,255,.85)";
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(player.x, player.y, 32, 0, Math.PI * 2);
    ctx.stroke();
  }
  const grad = ctx.createRadialGradient(player.x - 8, player.y - 10, 4, player.x, player.y, 30);
  grad.addColorStop(0, "#ffffff");
  grad.addColorStop(0.22, player.color);
  grad.addColorStop(1, player.team === "red" ? "#6c0820" : "#07546a");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(player.x, player.y, 24, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = player.id === playerId ? 5 : 2;
  ctx.strokeStyle = player.id === playerId ? "#ffe45e" : "rgba(255,255,255,.7)";
  ctx.stroke();
  ctx.fillStyle = "rgba(0,0,0,.5)";
  ctx.fillRect(player.x - 28, player.y - 43, 56, 8);
  ctx.fillStyle = "#ffe45e";
  ctx.fillRect(player.x - 28, player.y - 43, 56 * player.stamina, 8);
  ctx.fillStyle = "#f8ffe8";
  ctx.font = "700 15px Trebuchet MS";
  ctx.textAlign = "center";
  ctx.fillText(player.name, player.x, player.y + 44);
  if (player.power) {
    ctx.fillStyle = powerColor(player.power, 1);
    ctx.font = "900 13px Trebuchet MS";
    ctx.fillText(`${player.powerLabel} ${player.powerRemaining}s`, player.x, player.y - 54);
  }
}

function drawBall(ball) {
  ctx.shadowColor = "rgba(255,255,255,.6)";
  ctx.shadowBlur = 18;
  ctx.fillStyle = "#f8ffe8";
  ctx.beginPath();
  ctx.arc(ball.x, ball.y, 15, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = "#101010";
  ctx.lineWidth = 3;
  ctx.stroke();
}

function drawPowerup(powerup) {
  ctx.save();
  ctx.translate(powerup.x, powerup.y);
  ctx.rotate(performance.now() / 420);
  ctx.shadowColor = powerColor(powerup.type, 1);
  ctx.shadowBlur = 22;
  ctx.fillStyle = powerColor(powerup.type, 1);
  ctx.beginPath();
  for (let i = 0; i < 10; i += 1) {
    const r = i % 2 ? 9 : 22;
    const a = (Math.PI * 2 * i) / 10 - Math.PI / 2;
    ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  ctx.closePath();
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.rotate(-performance.now() / 420);
  ctx.fillStyle = "#06120d";
  ctx.font = "900 10px Trebuchet MS";
  ctx.textAlign = "center";
  ctx.fillText(powerup.label?.slice(0, 2).toUpperCase() ?? "★", 0, 4);
  ctx.restore();
}

function powerColor(type, alpha = 1) {
  const colors = {
    turbo: `rgba(255,138,61,${alpha})`,
    cannon: `rgba(255,228,94,${alpha})`,
    freeze: `rgba(38,217,255,${alpha})`,
    magnet: `rgba(215,134,255,${alpha})`
  };
  return colors[type] ?? `rgba(248,255,232,${alpha})`;
}

function render() {
  if (room) {
    drawField(room.field);
    for (const p of room.powerups) drawPowerup(p);
    drawBall(room.ball);
    for (const p of room.players) drawPlayer(p);
  }
  requestAnimationFrame(render);
}

createButton.addEventListener("click", createRoom);
joinButton.addEventListener("click", joinRoom);
startButton.addEventListener("click", () => send("start"));
copyInviteButton.addEventListener("click", copyInvite);
window.addEventListener("keydown", (event) => {
  if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.code)) event.preventDefault();
  keys.add(event.code);
  sendInput();
});
window.addEventListener("keyup", (event) => {
  keys.delete(event.code);
  sendInput();
});
setInterval(sendInput, 1000 / 30);
render();

const roomFromUrl = new URLSearchParams(location.search).get("room");
if (roomFromUrl) {
  roomCodeInput.value = roomFromUrl.toUpperCase();
  setStatus("Invitacion detectada: escribe tu nombre y pulsa Unirse.");
}
serverUrlInput.value = resolveServerUrl();
