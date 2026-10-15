// Vault mutations as the UI performs them: run, refresh, report.

import { asApiError, type ApiError } from "./api";
import { errorText } from "./i18n";
import { useUi, useVault } from "./store";

export function reportError(e: unknown): ApiError {
  const error = asApiError(e);
  useUi.getState().toast("error", errorText(error), error.detail ?? undefined);
  return error;
}

/**
 * Runs a vault change, then reloads the snapshot. Resolves to `undefined`
 * when the change failed (the failure has already been shown).
 */
export async function mutate<T>(action: () => Promise<T>, success?: string): Promise<T | undefined> {
  try {
    const result = await action();
    await useVault.getState().refresh();
    if (success) useUi.getState().toast("success", success);
    return result;
  } catch (e) {
    reportError(e);
    return undefined;
  }
}
