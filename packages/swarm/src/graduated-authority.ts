import type { ContractSLO, ContractMonitoring, ContractPermissionBoundary, MonitoringLevel } from "./types.js";

export type TrustTier = "low" | "medium" | "high";

export interface GraduatedAuthorityConfig {
  low_threshold: number;
  high_threshold: number;
  low_report_interval_ms: number;
  medium_report_interval_ms: number;
  low_budget_factor: number;
  medium_budget_factor: number;
  high_budget_factor: number;
  low_max_permissions: number;
  medium_max_permissions: number;
}

export const DEFAULT_GRADUATED_AUTHORITY_CONFIG: GraduatedAuthorityConfig = {
  low_threshold: 0.3,
  high_threshold: 0.7,
  low_report_interval_ms: 15000,
  medium_report_interval_ms: 60000,
  low_budget_factor: 0.5,
  medium_budget_factor: 1.0,
  high_budget_factor: 1.5,
  low_max_permissions: 3,
  medium_max_permissions: 10,
};

export function getTrustTier(
  trustScore: number,
  config: GraduatedAuthorityConfig = DEFAULT_GRADUATED_AUTHORITY_CONFIG,
): TrustTier {
  if (trustScore < config.low_threshold) return "low";
  if (trustScore >= config.high_threshold) return "high";
  return "medium";
}

export function authorityFromTrust(
  trustScore: number,
  baseSlo: ContractSLO,
  baseMonitoring: ContractMonitoring,
  basePermBoundary?: ContractPermissionBoundary,
  config: GraduatedAuthorityConfig = DEFAULT_GRADUATED_AUTHORITY_CONFIG,
): {
  slo: ContractSLO;
  monitoring: ContractMonitoring;
  permission_boundary: ContractPermissionBoundary;
  trust_tier: TrustTier;
} {
  const tier = getTrustTier(trustScore, config);

  let budgetFactor: number;
  let monitoring: ContractMonitoring;

  switch (tier) {
    case "low":
      budgetFactor = config.low_budget_factor;
      monitoring = {
        require_checkpoints: true,
        report_interval_ms: config.low_report_interval_ms,
        monitoring_level: "L2_COT_TRACE" as MonitoringLevel,
      };
      break;
    case "medium":
      budgetFactor = config.medium_budget_factor;
      monitoring = {
        require_checkpoints: true,
        report_interval_ms: config.medium_report_interval_ms,
        monitoring_level: "L1_HIGH_LEVEL_PLAN" as MonitoringLevel,
      };
      break;
    case "high":
      budgetFactor = config.high_budget_factor;
      monitoring = {
        require_checkpoints: false,
        monitoring_level: "L0_IS_OPERATIONAL" as MonitoringLevel,
      };
      break;
  }

  const slo: ContractSLO = {
    max_duration_ms: Math.round(baseSlo.max_duration_ms * budgetFactor),
    max_tokens: Math.round(baseSlo.max_tokens * budgetFactor),
    max_cost_usd: baseSlo.max_cost_usd * budgetFactor,
  };

  let permission_boundary: ContractPermissionBoundary;
  switch (tier) {
    case "low":
      permission_boundary = {
        tool_allowlist: basePermBoundary?.tool_allowlist,
        readonly_paths: basePermBoundary?.readonly_paths,
        max_permissions: config.low_max_permissions,
      };
      break;
    case "medium":
      permission_boundary = {
        tool_allowlist: basePermBoundary?.tool_allowlist,
        readonly_paths: basePermBoundary?.readonly_paths,
        max_permissions: config.medium_max_permissions,
      };
      break;
    case "high":
      permission_boundary = basePermBoundary ?? {};
      break;
  }

  return { slo, monitoring, permission_boundary, trust_tier: tier };
}
