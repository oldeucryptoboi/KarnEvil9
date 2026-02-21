const SENSITIVE_KEYS = /^(authorization|password|secret|token|api[_-]?key|credential|private[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|connection[_-]?string|database[_-]?url)$/i;
const SENSITIVE_VALUES = /Bearer\s|ghp_|gho_|github_pat_|sk-ant-|sk-proj-|sk-|AKIA[A-Z0-9]{16}|xox[bpas]-|eyJ[A-Za-z0-9_-]{10,}\.|-----BEGIN\s+(?:RSA\s+|EC\s+|OPENSSH\s+)?PRIVATE\s+KEY|AIza[A-Za-z0-9_-]{35}|ya29\.[A-Za-z0-9_-]+|sk_live_|sk_test_|rk_live_|rk_test_|pk_live_|pk_test_|whsec_|sbp_[A-Za-z0-9]{40}|SG\.[A-Za-z0-9_-]{22}\.|AC[a-f0-9]{32}|sk[a-f0-9]{32}|glpat-[A-Za-z0-9_-]{20}|npm_[A-Za-z0-9]{36}|pypi-[A-Za-z0-9]{36}|mongodb(\+srv)?:\/\/[^\s]+|postgres(ql)?:\/\/[^\s]+|mysql:\/\/[^\s]+|redis:\/\/[^\s]+/;

export function redactPayload(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") {
    if (typeof value === "string" && SENSITIVE_VALUES.test(value)) return "[REDACTED]";
    return value;
  }
  if (Array.isArray(value)) return value.map(redactPayload);
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.test(k) && typeof v === "string") {
      result[k] = "[REDACTED]";
    } else {
      result[k] = redactPayload(v);
    }
  }
  return result;
}
