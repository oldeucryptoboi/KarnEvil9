export interface ActionRequest {
  action: string;
  [key: string]: unknown;
}

export interface ActionResult {
  success: boolean;
  [key: string]: unknown;
}

export interface BrowserDriver {
  execute(request: ActionRequest): Promise<ActionResult>;
  close(): Promise<void>;
  isActive(): boolean;
}

export interface Target {
  role?: string;
  name?: string;
  label?: string;
  text?: string;
  placeholder?: string;
  selector?: string;
  nth?: number;
}
