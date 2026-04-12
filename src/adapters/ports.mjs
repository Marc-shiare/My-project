import { AppError } from "../lib/errors.mjs";

export function createManualAdapters() {
  return {
    identityContextPort: {
      async resolveActor(actor) {
        return actor;
      },
    },
    settlementChannelPort: {
      async checkFloatAvailability({ channelType, currency }) {
        return {
          floatAccountRef: `MANUAL_FLOAT:${channelType}:${currency}`,
          availableFloatMinor: 9_999_999_999,
        };
      },
      async initiateSettlement(request) {
        return {
          providerStatus: "confirmed",
          providerReference: request.paymentReference,
          confirmedAmountMinor: request.amountMinor,
          providerConfirmedAt: new Date().toISOString(),
          externalStatus: "MANUALLY_CONFIRMED",
        };
      },
      async pollSettlement(request) {
        return {
          providerStatus: "confirmed",
          providerReference: request.providerReference ?? request.paymentReference,
          confirmedAmountMinor: request.amountMinor,
          providerConfirmedAt: new Date().toISOString(),
          externalStatus: "MANUALLY_CONFIRMED",
        };
      },
      async reverseSettlement(request) {
        return {
          providerStatus: "reversed",
          providerReference: request.providerReference ?? request.paymentReference,
          reversedAmountMinor: request.amountMinor,
          reversedAt: new Date().toISOString(),
        };
      },
      async dispatchSettlement() {
        throw new AppError(
          "ADAPTER_UNAVAILABLE",
          "Settlement channel adapter is not configured. Record manual confirmation or plug in a real payment rail adapter.",
          501,
        );
      },
    },
    statementImportPort: {
      async ingestBatch(lines) {
        return lines;
      },
    },
  };
}

export function createSimulatedAdapters(options = {}) {
  const scenarios = new Map(Object.entries(options.settlementScenarios ?? {}));
  const floatBalances = new Map(
    Object.entries(options.floatBalances ?? {}).map(([key, value]) => [key, Number(value)]),
  );
  const reservations = new Map();
  const dispatches = new Map();

  function keyFor(channelType, currency) {
    return `${channelType}:${currency}`;
  }

  function getScenario(paymentReference) {
    return scenarios.get(paymentReference) ?? { mode: "confirm_immediately" };
  }

  function currentFloat(channelType, currency) {
    return floatBalances.get(keyFor(channelType, currency)) ?? 9_999_999_999;
  }

  function reserveFloat(channelType, currency, settlementId, amountMinor) {
    const key = keyFor(channelType, currency);
    floatBalances.set(key, currentFloat(channelType, currency) - amountMinor);
    reservations.set(settlementId, { key, amountMinor });
  }

  function releaseFloat(settlementId) {
    const reservation = reservations.get(settlementId);
    if (!reservation) {
      return;
    }
    floatBalances.set(reservation.key, (floatBalances.get(reservation.key) ?? 0) + reservation.amountMinor);
    reservations.delete(settlementId);
  }

  return {
    identityContextPort: {
      async resolveActor(actor) {
        return actor;
      },
    },
    settlementChannelPort: {
      async checkFloatAvailability({ channelType, currency }) {
        return {
          floatAccountRef: `SIM_FLOAT:${channelType}:${currency}`,
          availableFloatMinor: currentFloat(channelType, currency),
        };
      },
      async initiateSettlement(request) {
        const scenario = getScenario(request.paymentReference);
        if (scenario.mode === "api_failure" && (scenario.failuresRemaining ?? 1) > 0) {
          scenario.failuresRemaining = (scenario.failuresRemaining ?? 1) - 1;
          scenarios.set(request.paymentReference, scenario);
          throw new AppError("ADAPTER_UNAVAILABLE", "Simulated settlement provider API failure.", 503);
        }

        if (scenario.mode === "duplicate_transaction") {
          return {
            providerStatus: "failed",
            failureCode: "DUPLICATE_TRANSACTION",
            retryable: false,
            reason: "Simulated duplicate transaction rejection.",
          };
        }

        reserveFloat(request.channelType, request.currency, request.settlementId, request.amountMinor);
        const providerReference = scenario.providerReference ?? `${request.paymentReference}-provider`;
        dispatches.set(request.settlementId, {
          paymentReference: request.paymentReference,
          providerReference,
          amountMinor: request.amountMinor,
          channelType: request.channelType,
          currency: request.currency,
          scenario,
          pollsCompleted: 0,
        });

        if (scenario.mode === "delayed_confirmation") {
          return {
            providerStatus: "pending_provider",
            providerReference,
            reason: "Simulated delayed provider confirmation.",
            nextReviewAt: new Date(Date.now() + 60_000).toISOString(),
          };
        }

        return {
          providerStatus: "confirmed",
          providerReference,
          confirmedAmountMinor: request.amountMinor,
          providerConfirmedAt: new Date().toISOString(),
          externalStatus: "SIMULATED_CONFIRMATION",
        };
      },
      async pollSettlement(request) {
        const dispatch = dispatches.get(request.settlementId);
        if (!dispatch) {
          return {
            providerStatus: "failed",
            failureCode: "PROVIDER_REJECTED",
            retryable: true,
            reason: "No simulated dispatch was found for this settlement.",
          };
        }

        if (dispatch.scenario.mode === "api_failure" && (dispatch.scenario.pollFailuresRemaining ?? 0) > 0) {
          dispatch.scenario.pollFailuresRemaining -= 1;
          return Promise.reject(new AppError("ADAPTER_UNAVAILABLE", "Simulated settlement status API failure.", 503));
        }

        if (dispatch.scenario.mode === "delayed_confirmation") {
          dispatch.pollsCompleted += 1;
          const pollsUntilConfirm = dispatch.scenario.pollsUntilConfirm ?? 1;
          if (dispatch.pollsCompleted <= pollsUntilConfirm) {
            return {
              providerStatus: "pending_provider",
              providerReference: dispatch.providerReference,
              reason: "Simulated delayed confirmation still pending.",
              nextReviewAt: new Date(Date.now() + 60_000).toISOString(),
            };
          }
        }

        return {
          providerStatus: "confirmed",
          providerReference: dispatch.providerReference,
          confirmedAmountMinor: dispatch.amountMinor,
          providerConfirmedAt: new Date().toISOString(),
          externalStatus: "SIMULATED_CONFIRMATION",
        };
      },
      async reverseSettlement(request) {
        releaseFloat(request.settlementId);
        return {
          providerStatus: "reversed",
          providerReference: request.providerReference ?? `${request.paymentReference}-provider`,
          reversedAmountMinor: request.amountMinor,
          reversedAt: new Date().toISOString(),
        };
      },
      async dispatchSettlement() {
        throw new AppError(
          "ADAPTER_UNAVAILABLE",
          "dispatchSettlement is deprecated. Use initiateSettlement through the settlement channel abstraction.",
          501,
        );
      },
    },
    statementImportPort: {
      async ingestBatch(lines) {
        return lines;
      },
    },
  };
}

export const adapterBoundaries = {
  identityContextPort: "Replace request-supplied actors with an authenticated principal and signed role claims.",
  settlementChannelPort:
    "Replace local float checks, initiation, polling, and reversal simulation with real bank, switch, or mobile money settlement adapters.",
  statementImportPort: "Replace manual statement upload with scheduled pulls or pushed settlement files from external systems.",
};
