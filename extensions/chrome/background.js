/**
 * OpenFlaw CDP Bridge — Background service worker.
 * Connects outbound to the relay's bridge WebSocket server and proxies
 * CDP commands to/from the attached tab via chrome.debugger API.
 */

const CDP_VERSION = "1.3";
const DEFAULT_BRIDGE_URL = "ws://localhost:9225";
const RECONNECT_DELAY_MS = 3000;

let relayWs = null;
let attachedTabId = null;
let bridgeUrl = DEFAULT_BRIDGE_URL;

// ── Badge management ──────────────────────────────────────────────

function updateBadge() {
  const wsConnected = relayWs && relayWs.readyState === WebSocket.OPEN;
  const debuggerAttached = attachedTabId !== null;

  if (wsConnected && debuggerAttached) {
    chrome.action.setBadgeText({ text: "ON" });
    chrome.action.setBadgeBackgroundColor({ color: "#22c55e" }); // green
  } else if (wsConnected || debuggerAttached) {
    chrome.action.setBadgeText({ text: "..." });
    chrome.action.setBadgeBackgroundColor({ color: "#f59e0b" }); // amber
  } else {
    chrome.action.setBadgeText({ text: "OFF" });
    chrome.action.setBadgeBackgroundColor({ color: "#ef4444" }); // red
  }
}

// ── WebSocket to relay ────────────────────────────────────────────

function connectToRelay() {
  if (relayWs && (relayWs.readyState === WebSocket.OPEN || relayWs.readyState === WebSocket.CONNECTING)) {
    return;
  }

  try {
    relayWs = new WebSocket(bridgeUrl);
  } catch {
    relayWs = null;
    updateBadge();
    scheduleReconnect();
    return;
  }

  relayWs.onopen = () => {
    console.log("[bridge] WS connected to relay");
    updateBadge();
    // If already attached to a tab, send hello
    if (attachedTabId !== null) {
      sendBridgeHello();
    }
  };

  relayWs.onmessage = (event) => {
    if (attachedTabId === null) return;

    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    // CDP request from relay: {id, method, params}
    if (msg.id != null && msg.method) {
      const target = { tabId: attachedTabId };
      chrome.debugger.sendCommand(target, msg.method, msg.params || {}, (result) => {
        if (chrome.runtime.lastError) {
          sendToRelay({
            id: msg.id,
            error: { code: -32000, message: chrome.runtime.lastError.message },
          });
        } else {
          sendToRelay({ id: msg.id, result: result || {} });
        }
      });
    }
  };

  relayWs.onclose = () => {
    relayWs = null;
    updateBadge();
    scheduleReconnect();
  };

  relayWs.onerror = () => {
    // onclose will fire after this
  };
}

function scheduleReconnect() {
  setTimeout(connectToRelay, RECONNECT_DELAY_MS);
}

function sendToRelay(msg) {
  if (relayWs && relayWs.readyState === WebSocket.OPEN) {
    relayWs.send(JSON.stringify(msg));
  }
}

function sendBridgeHello() {
  if (attachedTabId === null) return;
  chrome.tabs.get(attachedTabId, (tab) => {
    if (chrome.runtime.lastError) {
      console.error("[bridge] tabs.get failed:", chrome.runtime.lastError.message);
      return;
    }
    console.log("[bridge] sending bridge:hello for tab", attachedTabId, tab.url);
    sendToRelay({
      type: "bridge:hello",
      tabId: attachedTabId,
      tabUrl: tab.url || "",
      tabTitle: tab.title || "",
    });
  });
}

// ── Debugger management ──────────────────────────────────────────

function attachToTab(tabId) {
  if (attachedTabId !== null) {
    // Detach from current tab first
    detachFromTab(() => doAttach(tabId));
    return;
  }
  doAttach(tabId);
}

function doAttach(tabId) {
  console.log("[bridge] attaching debugger to tab", tabId);
  chrome.debugger.attach({ tabId }, CDP_VERSION, () => {
    if (chrome.runtime.lastError) {
      console.error("[bridge] attach failed:", chrome.runtime.lastError.message);
      updateBadge();
      return;
    }
    console.log("[bridge] debugger attached to tab", tabId);
    attachedTabId = tabId;
    updateBadge();
    sendBridgeHello();
  });
}

function detachFromTab(callback) {
  if (attachedTabId === null) {
    if (callback) callback();
    return;
  }
  const tabId = attachedTabId;
  attachedTabId = null;
  chrome.debugger.detach({ tabId }, () => {
    // Ignore errors (tab may already be closed)
    updateBadge();
    if (callback) callback();
  });
}

// ── Debugger event forwarding ────────────────────────────────────

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId !== attachedTabId) return;
  sendToRelay({ method, params: params || {} });
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId !== attachedTabId) return;
  attachedTabId = null;
  sendToRelay({ type: "bridge:detached", reason });
  updateBadge();
});

// ── Message API for popup ────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "getStatus") {
    sendResponse({
      wsConnected: relayWs && relayWs.readyState === WebSocket.OPEN,
      attachedTabId,
      bridgeUrl,
    });
  } else if (message.type === "attach") {
    console.log("[bridge] popup requested attach to tab", message.tabId);
    attachToTab(message.tabId);
    sendResponse({ ok: true });
  } else if (message.type === "detach") {
    detachFromTab();
    sendResponse({ ok: true });
  } else if (message.type === "setBridgeUrl") {
    bridgeUrl = message.url || DEFAULT_BRIDGE_URL;
    // Reconnect to new URL
    if (relayWs) {
      relayWs.close();
    }
    connectToRelay();
    sendResponse({ ok: true });
  }
  return true; // async response
});

// ── Start ────────────────────────────────────────────────────────

connectToRelay();
updateBadge();
