import { getConfig } from "../../config/index.js";
import type { ProviderRegistry } from "../../llm/provider/index.js";
import { resolveLlmConfig } from "../../llm/provider/index.js";
import { estimateUsageCostUsd } from "../../llm/provider/usage-cost.js";
import type { ResolvedRunMode } from "../../llm/run-mode/index.js";
import type { SessionUsageLedger } from "../../session/usage-meter.js";
import type { AgentLoopDependencies } from "../../agent/agent-contract.js";
import { resolveModelPricingFor } from "../resolve-model-pricing.js";

/**
 * Kodevagten's consult (`agent/policies/question-escalation.ts`): one
 * completion pinned to `llm.runMode.fusion.questionProvider`, never the
 * fallback chain, so the question cannot land on a model the operator did
 * not pick for it. Read per fusion turn from the live run mode; `null`
 * while it is off. The call goes straight to the provider, past the seam
 * that feeds the session's readout, so it is counted here, the way an
 * escalation is (ATO-1388).
 */
export function createQuestionEscalation(deps: {
  resolveCurrentRunMode: () => ResolvedRunMode;
  providerRegistry: Pick<ProviderRegistry, "getProvider">;
  sessionUsage?: Pick<SessionUsageLedger, "record">;
}): NonNullable<AgentLoopDependencies["questionEscalation"]> {
  return () => {
    const target = deps.resolveCurrentRunMode().question ?? null;
    if (target === null) return null;
    return {
      maxPerTurn: target.maxPerTurn,
      consult: async ({ prompt, maxOutputTokens, signal, sessionId }) => {
        const provider = deps.providerRegistry.getProvider(target.providerId);
        if (provider === undefined) {
          throw new Error(
            `question provider ${target.providerId} is not configured`,
          );
        }
        const result = await provider.complete({ prompt, maxOutputTokens, signal });
        let costUsd: number | null = null;
        try {
          const resolved = resolveLlmConfig(getConfig());
          const entry = resolved.providers.find((p) => p.id === target.providerId);
          const model = resolveModelPricingFor(resolved, result.modelId, target.providerId);
          if (model?.pricing !== undefined && result.usage !== undefined) {
            costUsd = estimateUsageCostUsd(result.usage, model.pricing);
          }
          deps.sessionUsage?.record(sessionId, {
            providerId: target.providerId,
            modelId: result.modelId,
            ...(result.usage === undefined ? {} : { usage: result.usage }),
            ...(model === undefined ? {} : { model }),
            local: entry?.kind === "llama-server",
            plan: entry?.kind === "subscription-cli",
          });
        } catch {
          // The readout never takes the consult down.
        }
        return {
          content: result.content,
          providerId: target.providerId,
          model: result.modelId ?? target.model,
          costUsd,
        };
      },
    };
  };
}
