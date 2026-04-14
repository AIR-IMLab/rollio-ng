export type EpisodeKeyBindings = {
  startKey: string;
  stopKey: string;
  keepKey: string;
  discardKey: string;
};

export interface UiRuntimeConfig {
  websocketUrl: string;
  episodeKeyBindings: EpisodeKeyBindings;
}

type RawUiRuntimeConfig = {
  websocketUrl?: unknown;
  episodeKeyBindings?: Partial<Record<keyof EpisodeKeyBindings, unknown>>;
};

function normalizeKey(
  label: keyof EpisodeKeyBindings,
  value: unknown,
): string {
  if (typeof value !== "string" || value.trim().length !== 1) {
    throw new Error(`runtime config "${label}" must be a single character`);
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "d") {
    throw new Error(`runtime config "${label}" conflicts with reserved shortcut "d"`);
  }
  return normalized;
}

export function normalizeRuntimeConfig(
  config: RawUiRuntimeConfig,
): UiRuntimeConfig {
  if (typeof config.websocketUrl !== "string" || config.websocketUrl.trim() === "") {
    throw new Error('runtime config "websocketUrl" must be a non-empty string');
  }

  const episodeKeyBindings = {
    startKey: normalizeKey("startKey", config.episodeKeyBindings?.startKey),
    stopKey: normalizeKey("stopKey", config.episodeKeyBindings?.stopKey),
    keepKey: normalizeKey("keepKey", config.episodeKeyBindings?.keepKey),
    discardKey: normalizeKey("discardKey", config.episodeKeyBindings?.discardKey),
  };

  const seen = new Set<string>();
  for (const key of Object.values(episodeKeyBindings)) {
    if (seen.has(key)) {
      throw new Error(`runtime config contains duplicate key binding "${key}"`);
    }
    seen.add(key);
  }

  return {
    websocketUrl: config.websocketUrl.trim(),
    episodeKeyBindings,
  };
}

export async function loadRuntimeConfig(
  fetchImpl: typeof fetch = fetch,
): Promise<UiRuntimeConfig> {
  const response = await fetchImpl("/api/runtime-config", {
    cache: "no-store",
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`failed to load runtime config: HTTP ${response.status}`);
  }

  const payload = (await response.json()) as RawUiRuntimeConfig;
  return normalizeRuntimeConfig(payload);
}
