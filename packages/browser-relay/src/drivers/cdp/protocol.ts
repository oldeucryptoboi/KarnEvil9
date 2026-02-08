/**
 * Minimal CDP type definitions for the methods we use.
 * Covers Page, Runtime, DOM, Input, Accessibility domains.
 */

// ── Generic CDP message types ────────────────────────────────────────

export interface CDPRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface CDPResponse {
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

export interface CDPEvent {
  method: string;
  params?: Record<string, unknown>;
}

// ── Target info from /json/list ──────────────────────────────────────

export interface CDPTargetInfo {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
  devtoolsFrontendUrl?: string;
}

export interface CDPVersionInfo {
  Browser: string;
  "Protocol-Version": string;
  "User-Agent": string;
  "V8-Version": string;
  "WebKit-Version": string;
  webSocketDebuggerUrl: string;
}

// ── Page domain ──────────────────────────────────────────────────────

export interface PageNavigateParams {
  url: string;
}

export interface PageNavigateResult {
  frameId: string;
  loaderId?: string;
  errorText?: string;
}

export interface PageCaptureScreenshotParams {
  format?: "jpeg" | "png" | "webp";
  quality?: number;
  clip?: { x: number; y: number; width: number; height: number; scale?: number };
  fromSurface?: boolean;
  captureBeyondViewport?: boolean;
}

export interface PageCaptureScreenshotResult {
  data: string; // base64
}

// ── Runtime domain ───────────────────────────────────────────────────

export interface RemoteObject {
  type: string;
  subtype?: string;
  className?: string;
  value?: unknown;
  objectId?: string;
  description?: string;
}

export interface ExceptionDetails {
  exceptionId: number;
  text: string;
  lineNumber: number;
  columnNumber: number;
  exception?: RemoteObject;
}

export interface RuntimeEvaluateParams {
  expression: string;
  returnByValue?: boolean;
  awaitPromise?: boolean;
}

export interface RuntimeEvaluateResult {
  result: RemoteObject;
  exceptionDetails?: ExceptionDetails;
}

export interface RuntimeCallFunctionOnParams {
  functionDeclaration: string;
  objectId?: string;
  arguments?: Array<{ value?: unknown; objectId?: string }>;
  returnByValue?: boolean;
  awaitPromise?: boolean;
}

export interface RuntimeCallFunctionOnResult {
  result: RemoteObject;
  exceptionDetails?: ExceptionDetails;
}

// ── Input domain ─────────────────────────────────────────────────────

export interface InputDispatchMouseEventParams {
  type: "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel";
  x: number;
  y: number;
  button?: "none" | "left" | "middle" | "right";
  clickCount?: number;
}

export interface InputDispatchKeyEventParams {
  type: "keyDown" | "keyUp" | "rawKeyDown" | "char";
  key?: string;
  code?: string;
  text?: string;
  windowsVirtualKeyCode?: number;
}

export interface InputInsertTextParams {
  text: string;
}

// ── DOM domain ───────────────────────────────────────────────────────

export interface DOMGetDocumentResult {
  root: { nodeId: number };
}

// ── Accessibility domain ─────────────────────────────────────────────

export interface AXNode {
  nodeId: string;
  ignored: boolean;
  role?: { type: string; value: string };
  name?: { type: string; value: string };
  properties?: Array<{ name: string; value: { type: string; value: unknown } }>;
  children?: AXNode[];
  childIds?: string[];
  backendDOMNodeId?: number;
}

export interface AccessibilityGetFullAXTreeResult {
  nodes: AXNode[];
}

// ── CDP method → params/result mapping ───────────────────────────────

export interface CDPMethodMap {
  "Page.enable": { params: void; result: void };
  "Page.navigate": { params: PageNavigateParams; result: PageNavigateResult };
  "Page.captureScreenshot": { params: PageCaptureScreenshotParams; result: PageCaptureScreenshotResult };
  "Runtime.enable": { params: void; result: void };
  "Runtime.evaluate": { params: RuntimeEvaluateParams; result: RuntimeEvaluateResult };
  "Runtime.callFunctionOn": { params: RuntimeCallFunctionOnParams; result: RuntimeCallFunctionOnResult };
  "Input.dispatchMouseEvent": { params: InputDispatchMouseEventParams; result: void };
  "Input.dispatchKeyEvent": { params: InputDispatchKeyEventParams; result: void };
  "Input.insertText": { params: InputInsertTextParams; result: void };
  "DOM.enable": { params: void; result: void };
  "DOM.getDocument": { params: void; result: DOMGetDocumentResult };
  "Accessibility.enable": { params: void; result: void };
  "Accessibility.getFullAXTree": { params: void; result: AccessibilityGetFullAXTreeResult };
}
