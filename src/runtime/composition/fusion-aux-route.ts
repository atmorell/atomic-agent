import type { LlmStreamParams } from "../../agent/step/step-contract.js";
import type { ResolvedRunMode } from "../../llm/run-mode/index.js";

/**
 * Where a turn's auxiliary calls (session title, reflection, memory link
 * generation, votes, query rewrite, distillation) run.
 *
 * Unpinned, they ride the active text provider — in fusion that is the
 * cloud orchestrator, so bookkeeping no one reads in the turn spends the
 * leg fusion exists to save (measured 15-11-2026: 8-20 % of a Claude-only
 * baseline per task). In fusion with a worker leg they are pinned to that
 * leg instead; outside fusion nothing changes.
 *
 * A pin never falls over (`LlmStreamParams.providerId`), so when the local
 * leg is down these calls fail and surface as memory health warnings
 * rather than silently returning to the cloud.
 */
export function fusionAuxProviderId(runMode: ResolvedRunMode): string | undefined {
  return runMode.effective === "fusion" && runMode.workerProviderId !== null
    ? runMode.workerProviderId
    : undefined;
}

/**
 * Wrap a completion function so unpinned calls follow `fusionAuxProviderId`,
 * read per call: a `/llm` or route switch takes effect on the next call.
 * A caller's own pin always wins.
 */
export function pinToFusionWorker<P extends Pick<LlmStreamParams, "providerId">, R>(
  complete: (params: P) => Promise<R>,
  resolveRunMode: () => ResolvedRunMode,
): (params: P) => Promise<R> {
  return (params) => {
    if (params.providerId !== undefined) return complete(params);
    const providerId = fusionAuxProviderId(resolveRunMode());
    return complete(providerId === undefined ? params : { ...params, providerId });
  };
}
