import { AppError } from "../lib/errors.mjs";

export function createManualAdapters() {
  return {
    identityContextPort: {
      async resolveActor(actor) {
        return actor;
      },
    },
    settlementChannelPort: {
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

export const adapterBoundaries = {
  identityContextPort: "Replace request-supplied actors with an authenticated principal and signed role claims.",
  settlementChannelPort: "Replace manual settlement recording with real bank, switch, or mobile money dispatch adapters.",
  statementImportPort: "Replace manual statement upload with scheduled pulls or pushed settlement files from external systems.",
};
