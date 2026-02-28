/**
 * OpenFlaw CDP Bridge — Popup logic.
 * Queries background service worker for bridge status and provides attach/detach controls.
 */

document.addEventListener("DOMContentLoaded", () => {
  const wsIndicator = document.getElementById("ws-indicator");
  const wsStatus = document.getElementById("ws-status");
  const dbgIndicator = document.getElementById("dbg-indicator");
  const dbgStatus = document.getElementById("dbg-status");
  const details = document.getElementById("details");
  const attachBtn = document.getElementById("attach-btn");
  const detachBtn = document.getElementById("detach-btn");
  const bridgeUrlText = document.getElementById("bridge-url-text");

  chrome.runtime.sendMessage({ type: "getStatus" }, (status) => {
    if (chrome.runtime.lastError || !status) {
      wsIndicator.classList.add("disconnected");
      wsStatus.textContent = "Relay: Unable to query";
      dbgIndicator.classList.add("disconnected");
      dbgStatus.textContent = "Debugger: Unable to query";
      return;
    }

    // Relay WS status
    if (status.wsConnected) {
      wsIndicator.classList.add("connected");
      wsStatus.textContent = "Relay: Connected";
    } else {
      wsIndicator.classList.add("disconnected");
      wsStatus.textContent = "Relay: Disconnected";
    }

    // Debugger status
    if (status.attachedTabId !== null) {
      dbgIndicator.classList.add("connected");
      dbgStatus.textContent = `Debugger: Attached (tab ${status.attachedTabId})`;
      detachBtn.disabled = false;
    } else {
      dbgIndicator.classList.add("disconnected");
      dbgStatus.textContent = "Debugger: Not attached";
      attachBtn.disabled = false;
    }

    // Bridge URL
    bridgeUrlText.textContent = status.bridgeUrl || "ws://localhost:9225";
  });

  attachBtn.addEventListener("click", () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs.length === 0) return;
      chrome.runtime.sendMessage({ type: "attach", tabId: tabs[0].id }, () => {
        window.close();
      });
    });
  });

  detachBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "detach" }, () => {
      window.close();
    });
  });
});
