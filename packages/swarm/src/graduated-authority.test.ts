import { describe, it, expect } from "vitest";
import {
  getTrustTier,
  authorityFromTrust,
  DEFAULT_GRADUATED_AUTHORITY_CONFIG,
} from "./graduated-authority.js";
import type { ContractSLO, ContractMonitoring, ContractPermissionBoundary } from "./types.js";

const baseSlo: ContractSLO = {
  max_duration_ms: 300000,
  max_tokens: 10000,
  max_cost_usd: 1.0,
};

const baseMonitoring: ContractMonitoring = {
  require_checkpoints: false,
};

const basePermBoundary: ContractPermissionBoundary = {
  tool_allowlist: ["read-file", "write-file", "shell-exec"],
  readonly_paths: ["/tmp"],
  max_permissions: 20,
};

describe("getTrustTier", () => {
  it("should classify score 0 as low", () => {
    expect(getTrustTier(0)).toBe("low");
  });

  it("should classify score just below low_threshold as low", () => {
    expect(getTrustTier(0.29)).toBe("low");
  });

  it("should classify score at low_threshold as medium", () => {
    expect(getTrustTier(0.3)).toBe("medium");
  });

  it("should classify mid-range score as medium", () => {
    expect(getTrustTier(0.5)).toBe("medium");
  });

  it("should classify score just below high_threshold as medium", () => {
    expect(getTrustTier(0.69)).toBe("medium");
  });

  it("should classify score at high_threshold as high", () => {
    expect(getTrustTier(0.7)).toBe("high");
  });

  it("should classify score 1.0 as high", () => {
    expect(getTrustTier(1.0)).toBe("high");
  });

  it("should respect custom thresholds", () => {
    const config = { ...DEFAULT_GRADUATED_AUTHORITY_CONFIG, low_threshold: 0.2, high_threshold: 0.8 };
    expect(getTrustTier(0.19, config)).toBe("low");
    expect(getTrustTier(0.2, config)).toBe("medium");
    expect(getTrustTier(0.79, config)).toBe("medium");
    expect(getTrustTier(0.8, config)).toBe("high");
  });
});

describe("authorityFromTrust", () => {
  it("should scale SLO down for low trust", () => {
    const result = authorityFromTrust(0.1, baseSlo, baseMonitoring, basePermBoundary);
    expect(result.trust_tier).toBe("low");
    expect(result.slo.max_duration_ms).toBe(150000);
    expect(result.slo.max_tokens).toBe(5000);
    expect(result.slo.max_cost_usd).toBe(0.5);
  });

  it("should keep SLO at 1x for medium trust", () => {
    const result = authorityFromTrust(0.5, baseSlo, baseMonitoring, basePermBoundary);
    expect(result.trust_tier).toBe("medium");
    expect(result.slo.max_duration_ms).toBe(300000);
    expect(result.slo.max_tokens).toBe(10000);
    expect(result.slo.max_cost_usd).toBe(1.0);
  });

  it("should scale SLO up for high trust", () => {
    const result = authorityFromTrust(0.9, baseSlo, baseMonitoring, basePermBoundary);
    expect(result.trust_tier).toBe("high");
    expect(result.slo.max_duration_ms).toBe(450000);
    expect(result.slo.max_tokens).toBe(15000);
    expect(result.slo.max_cost_usd).toBe(1.5);
  });

  it("should require checkpoints for low trust at 15s interval", () => {
    const result = authorityFromTrust(0.1, baseSlo, baseMonitoring);
    expect(result.monitoring.require_checkpoints).toBe(true);
    expect(result.monitoring.report_interval_ms).toBe(15000);
  });

  it("should require checkpoints for medium trust at 60s interval", () => {
    const result = authorityFromTrust(0.5, baseSlo, baseMonitoring);
    expect(result.monitoring.require_checkpoints).toBe(true);
    expect(result.monitoring.report_interval_ms).toBe(60000);
  });

  it("should not require checkpoints for high trust", () => {
    const result = authorityFromTrust(0.9, baseSlo, baseMonitoring);
    expect(result.monitoring.require_checkpoints).toBe(false);
    expect(result.monitoring.report_interval_ms).toBeUndefined();
  });

  it("should limit permissions to 3 for low trust", () => {
    const result = authorityFromTrust(0.1, baseSlo, baseMonitoring, basePermBoundary);
    expect(result.permission_boundary.max_permissions).toBe(3);
    expect(result.permission_boundary.tool_allowlist).toEqual(basePermBoundary.tool_allowlist);
  });

  it("should limit permissions to 10 for medium trust", () => {
    const result = authorityFromTrust(0.5, baseSlo, baseMonitoring, basePermBoundary);
    expect(result.permission_boundary.max_permissions).toBe(10);
  });

  it("should pass through permissions for high trust", () => {
    const result = authorityFromTrust(0.9, baseSlo, baseMonitoring, basePermBoundary);
    expect(result.permission_boundary).toEqual(basePermBoundary);
  });

  it("should return empty permission boundary for high trust when no base provided", () => {
    const result = authorityFromTrust(0.9, baseSlo, baseMonitoring);
    expect(result.permission_boundary).toEqual({});
  });

  it("should work with custom config", () => {
    const config = {
      ...DEFAULT_GRADUATED_AUTHORITY_CONFIG,
      low_threshold: 0.4,
      high_threshold: 0.8,
      low_budget_factor: 0.3,
      high_budget_factor: 2.0,
    };
    const result = authorityFromTrust(0.35, baseSlo, baseMonitoring, undefined, config);
    expect(result.trust_tier).toBe("low");
    expect(result.slo.max_duration_ms).toBe(90000);

    const highResult = authorityFromTrust(0.85, baseSlo, baseMonitoring, undefined, config);
    expect(highResult.trust_tier).toBe("high");
    expect(highResult.slo.max_duration_ms).toBe(600000);
  });
});
