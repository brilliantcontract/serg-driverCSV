const fs = require("fs").promises;
const WebSocket = require("ws");

const { WebSocketServer } = WebSocket;
const wsServer = new WebSocketServer({ port: 8016 });

const clients = new Set();

let groupedDataQueue = [];
let broadcastInterval = null;

wsServer.on("connection", (ws) => {
  console.log("🟢 New client connected");
  clients.add(ws);

  ws.on("message", (data) => {
    const message = data.toString("utf-8");

    let parsed;
    try {
      parsed = JSON.parse(message);
    } catch (err) {
      console.error("❌ Invalid JSON:", message);
      return;
    }

    if (parsed.type === "ping") {
      const ts = Date.now();
      ws.send(JSON.stringify({ type: "pong", pongTime: ts }));
      console.log(`🏓 Pong sent: ${ts}`);
      return;
    }

    if (parsed.type === "start server") {
      runServer();
    }

    // Optional: Relay to other clients
    // broadcast(parsed, ws);
  });

  ws.on("close", () => {
    console.log("🔌 Client disconnected");
    clients.delete(ws);
  });

  ws.on("error", (err) => {
    console.error("🚨 WebSocket error:", err);
  });
});

// Send to all clients
function broadcast(dataToSend) {
  const message = JSON.stringify(dataToSend);
  for (const client of clients) {
    if (client.readyState === client.OPEN) {
      client.send(message);
    }
  }
}

async function runServer() {
  if (broadcastInterval) {
    clearInterval(broadcastInterval);
  }

  try {
    // Read ready-to-use JSON objects from list.json
    const data = await fs.readFile("list.json", "utf-8");
    const list = JSON.parse(data); // Should be an array of objects

    if (!Array.isArray(list)) {
      throw new Error("list.json does not contain a valid array of objects.");
    }

    groupedDataQueue = [...list]; // make a shallow copy

    // Send one instruction every 5 seconds
    broadcastInterval = setInterval(() => {
      if (groupedDataQueue.length === 0) {
        console.log("✅ All instructions sent. Stopping broadcast.");
        clearInterval(broadcastInterval);
        return;
      }

      const next = groupedDataQueue.shift();
      broadcast(next);
      console.log("📤 Sent to - f");
    }, 7000);

    console.log("✅ Ready. Sending one instruction");
  } catch (err) {
    console.error("❌ Failed to load or parse list.json:", err);
  }
}
