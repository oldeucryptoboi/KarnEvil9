import type {
  SwarmTaskResult,
  DelegationContract,
  TaskAttestation,
  AttestationChain,
  VerificationResult,
} from "./types.js";
import { verifyAttestation, verifyChain } from "./attestation.js";
import { verifyAttestationSignature } from "./ed25519-signer.js";

export interface VerifierConfig {
  slo_strict?: boolean;           // fail verification if any SLO exceeded
  min_findings_ratio?: number;    // minimum findings/expected ratio (default 0.5)
  verify_attestation_chain?: boolean;
}

export class OutcomeVerifier {
  private config: Required<VerifierConfig>;

  constructor(config?: VerifierConfig) {
    this.config = {
      slo_strict: config?.slo_strict ?? true,
      min_findings_ratio: config?.min_findings_ratio ?? 0.5,
      verify_attestation_chain: config?.verify_attestation_chain ?? true,
    };
  }

  verify(params: {
    result: SwarmTaskResult;
    contract?: DelegationContract;
    attestation?: TaskAttestation;
    attestation_chain?: AttestationChain;
    swarmToken?: string;
    peerPublicKey?: string;
    consensus_round_id?: string;
  }): VerificationResult {
    const issues: string[] = [];
    let slo_compliance = true;
    let findings_verified = false;
    let verification_method: VerificationResult["verification_method"] = "direct";
    let consensus_round_id: string | undefined;

    const { result, contract, attestation, attestation_chain, swarmToken, peerPublicKey } = params;

    // If consensus round provided, note it in the result
    if (params.consensus_round_id) {
      consensus_round_id = params.consensus_round_id;
      verification_method = "consensus";
    }

    // 1. SLO compliance check
    if (contract) {
      if (result.cost_usd > contract.slo.max_cost_usd) {
        issues.push(`Cost ${result.cost_usd} exceeds SLO max ${contract.slo.max_cost_usd}`);
        slo_compliance = false;
      }
      if (result.tokens_used > contract.slo.max_tokens) {
        issues.push(`Tokens ${result.tokens_used} exceeds SLO max ${contract.slo.max_tokens}`);
        slo_compliance = false;
      }
      if (result.duration_ms > contract.slo.max_duration_ms) {
        issues.push(`Duration ${result.duration_ms}ms exceeds SLO max ${contract.slo.max_duration_ms}ms`);
        slo_compliance = false;
      }
    }

    // 2. Ed25519 signature verification (strongest)
    const att = attestation ?? result.attestation;
    if (att && peerPublicKey && att.ed25519_signature) {
      const sigValid = verifyAttestationSignature(att, att.ed25519_signature, peerPublicKey);
      if (sigValid) {
        findings_verified = true;
        verification_method = "attestation";
      } else {
        issues.push("Ed25519 attestation signature verification failed");
      }
    }

    // 3. HMAC attestation verification
    if (!findings_verified && att && swarmToken) {
      const hmacValid = verifyAttestation(att, swarmToken);
      if (hmacValid) {
        findings_verified = true;
        verification_method = "attestation";
      } else {
        issues.push("HMAC attestation verification failed");
      }
    }

    // 4. Chain verification
    const chain = attestation_chain ?? result.attestation_chain;
    if (chain && swarmToken && this.config.verify_attestation_chain) {
      const chainResult = verifyChain(chain, swarmToken);
      if (!chainResult.valid) {
        issues.push(`Attestation chain invalid at depth ${chainResult.invalid_at_depth}`);
      }
    }

    // 5. Result quality check
    if (result.status === "completed" && result.findings.length === 0) {
      issues.push("Completed task has no findings");
    }

    // 6. Capability match check (findings tool_names vs contract tool_allowlist)
    if (contract?.permission_boundary?.tool_allowlist?.length) {
      const allowlist = new Set(contract.permission_boundary.tool_allowlist);
      const usedTools = new Set(result.findings.map((f) => f.tool_name));
      for (const tool of usedTools) {
        if (!allowlist.has(tool)) {
          issues.push(`Finding used tool '${tool}' not in allowlist`);
        }
      }
    }

    // If no attestation available, fall back to direct verification
    if (!findings_verified && !att) {
      // Direct verification: basic structural checks passed
      findings_verified = result.findings.length > 0 || result.status !== "completed";
      verification_method = "direct";
    }

    // When slo_strict is false, don't count SLO issues against verification
    const nonSloIssues = this.config.slo_strict
      ? issues
      : issues.filter((i) => !i.startsWith("Cost") && !i.startsWith("Tokens") && !i.startsWith("Duration"));

    const verified = (this.config.slo_strict ? slo_compliance : true) &&
      findings_verified &&
      nonSloIssues.length === 0;

    // Calculate outcome score
    let outcome_score: number | undefined;
    if (result.status === "completed") {
      const successFindings = result.findings.filter((f) => f.status === "succeeded").length;
      outcome_score = result.findings.length > 0 ? successFindings / result.findings.length : 0;
    }

    return {
      verified,
      outcome_score,
      slo_compliance,
      findings_verified,
      verification_method,
      consensus_round_id,
      issues: issues.length > 0 ? issues : undefined,
    };
  }
}
