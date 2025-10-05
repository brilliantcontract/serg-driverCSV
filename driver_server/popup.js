const wsUrls = ["ws://localhost:8011"];
const wsClients = {};
const reconnectInterval = 1000; // 1 second

function connectWebSocket(url) {
  console.log(`Connecting to WebSocket: ${url}`);

  const ws = new WebSocket(url);

  function pingRequestToWebSocketServer(socket) {
    if (socket && socket.readyState === WebSocket.OPEN) {
      const ts = Date.now();
      socket.send(JSON.stringify({ type: "ping", pingTime: ts }));
      console.log("Ping sent:", ts);
    }
  }

  function sendStart() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "start server" }));
      console.log("📤 Sent: start server");
    } else {
      console.warn("❌ WebSocket not open yet. Cannot send start signal.");
    }
  }

  // ✅ Attach click listener correctly
  document.getElementById("send").addEventListener("click", sendStart);

  ws.onopen = () => {
    console.log(`✅ Connected to WebSocket: ${url}`);
    ws.pingTimer = setInterval(() => pingRequestToWebSocketServer(ws), 9000);
    wsClients[url] = ws;
  };

  ws.onmessage = (event) => {
    try {
      const parsedData = JSON.parse(event.data);

      if (parsedData.type === "pong") {
        console.log("📡 pong:", parsedData.pongTime);
        return;
      }

      console.log(parsedData);

      chrome.runtime.sendMessage(
        { type: "START_SCRAPE", payload: parsedData },
        (response) => {
          if (chrome.runtime.lastError) {
            console.error("❌ Error sending to background:", chrome.runtime.lastError.message);
            return;
          }
          console.log("✅ Background response:", response);
          alert(response.status);
        }
      );
    } catch (err) {
      console.error(`🚨 Error parsing message from ${url}:`, err);
    }
  };

  ws.onclose = () => {
    console.log(`⚠️ WebSocket closed: ${url}. Reconnecting in ${reconnectInterval / 1000}s...`);
    clearInterval(ws.pingTimer);
    setTimeout(() => reconnectWebSocket(url), reconnectInterval);
  };

ws.onerror = (event) => {
  console.error("❌ WebSocket error event:", {
    type: event.type,
    message: event.message,
    target: event.target,
  });
};


  wsClients[url] = ws;
}

function reconnectWebSocket(url) {
  if (wsClients[url]) {
    wsClients[url].close();
  }
  connectWebSocket(url);
}

// Connect to all URLs on load
wsUrls.forEach(connectWebSocket);
