/** Native catalog lifecycle. Keeps network and candidate work outside startup
 * hydration; only validated offline bootstrap data can change the active game.
 */
import { progressionManifest } from "../hololive/vendor/shared/manifest";
import { accountManifest } from "../hololive/vendor/shared/account-data";
import { installCatalogData } from "./game";
import {
  normalizeCatalogCandidate,
  deriveCatalogArtwork,
  type CatalogAsset,
  type CatalogCandidate,
  type CatalogOverlay,
} from "./catalog-update";

function frozenSnapshot<T>(value: T): T {
  const snapshot = structuredClone(value);
  const freeze = (object: unknown) => {
    if (object && typeof object === "object" && !Object.isFrozen(object)) {
      for (const child of Object.values(object)) freeze(child);
      Object.freeze(object);
    }
  };
  freeze(snapshot);
  return snapshot;
}
// installCatalogData updates shared Maps/manifests. Validation and required-art
// decisions must always use the immutable bundled source, including after boot.
const baseline = frozenSnapshot(progressionManifest);
const baselineAccount = frozenSnapshot(accountManifest);
let activeCandidateId: string | null = null;

export type CatalogBootstrap = {
  candidate: CatalogCandidate | null;
  assetDir: string;
  warning?: string | null;
};
export type CatalogImageUrls = Record<
  string,
  {
    grid: string;
    full: string;
    vertical: string;
    landscape: string;
    thumb: string;
    root: string;
  }
>;
type PreloadStatus = {
  revision: number;
  checkedAt: number;
  added: number;
  lastChanges: {
    fromRevision: number;
    toRevision: number;
    cards: Record<string, string[]>;
    banners: Record<string, string[]>;
    characters: Record<string, string[]>;
  } | null;
};
export type CatalogState = {
  phase:
    | "idle"
    | "disabled"
    | "checking"
    | "downloading"
    | "current"
    | "ready"
    | "error";
  enabled: boolean;
  busy: boolean;
  message: string;
  error: string | null;
  checkedAt: number | null;
  completed: number;
  total: number;
  sourceCommit: string | null;
  warnings: string[];
  preloads: PreloadStatus | null;
  preloadUnavailable: boolean;
  optimizerNotice: string | null;
};
type Invoke = <T = unknown>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;
type Options = {
  invoke: Invoke;
  onState: (state: CatalogState) => void;
  onReady?: (boot: CatalogBootstrap, overlay: CatalogOverlay) => void;
  checkOptimizer?: (continueUpdate: () => boolean) => Promise<{updated: boolean; catalogError: string | null; mobileError: string | null}>;
  countCardsAwaitingOptimizer?: (cardIds: string[]) => Promise<number>;
  checkPreloads?: () => Promise<PreloadStatus>;
  getEnabled: () => boolean;
  setEnabled: (enabled: boolean) => void | Promise<void>;
};
const kinds = ["thumb", "full", "vertical", "grid", "landscape"] as const;
type Kind = (typeof kinds)[number];
const dimensions: Record<Kind, [number, number]> = {
  thumb: [512, 512],
  full: [1820, 1024],
  vertical: [256, 363],
  grid: [256, 256],
  landscape: [455, 256],
};
const assetPath = (id: string, kind: Kind) =>
  `assets/cards/${kind === "thumb" ? "" : kind + "/"}${id}.webp`;
function validRecord(
  record: CatalogAsset | undefined,
  id: string,
  kind: Kind,
): record is CatalogAsset {
  return (
    !!record &&
    record.assetId === id &&
    record.kind === kind &&
    record.path === assetPath(id, kind) &&
    /^[a-f0-9]{64}$/iu.test(record.sha256) &&
    Number.isSafeInteger(record.bytes) &&
    record.bytes > 0 &&
    record.bytes <= 8_000_000 &&
    record.width === dimensions[kind][0] &&
    record.height === dimensions[kind][1]
  );
}
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const catalogErrorText = (error: unknown) =>
  errorText(error).replace(/https?:\/\/[^\s<>"')\]]+/gi, 'the catalog server');
const normalize = (candidate: CatalogCandidate) =>
  normalizeCatalogCandidate(candidate, baseline, baselineAccount);

/** Called synchronously before profile hydration. Native bootstrap already
 * verifies file contents; this boundary checks identity/path/completeness before
 * invoking the game's atomic catalog installation seam.
 */
export function activateBootstrap(
  boot: CatalogBootstrap | undefined | null,
  convertFileSrc: (path: string) => string,
): { overlay: CatalogOverlay | null; warning: string | null } {
  if (!boot?.candidate)
    return { overlay: null, warning: boot?.warning ?? null };
  try {
    const overlay = normalize(boot.candidate);
    if (
      typeof boot.assetDir !== "string" ||
      !(
        /^[a-z]:[\\/]/iu.test(boot.assetDir) || boot.assetDir.startsWith("/")
      ) ||
      /[\u0000-\u001f]/u.test(boot.assetDir)
    )
      throw Error("Invalid catalog artwork folder.");
    const urls: CatalogImageUrls = {};
    for (const id of overlay.newAssetIds) {
      const paths: Partial<Record<Kind, string>> = {};
      for (const kind of kinds) {
        const record = boot.candidate.assets[`${kind}:${id}`];
        if (!validRecord(record, id, kind))
          throw Error("Cached catalog artwork is incomplete.");
        paths[kind] = convertFileSrc(
          `${boot.assetDir.replace(/[\\/]+$/u, "")}/${record.path}`,
        );
      }
      urls[id] = {
        grid: paths.grid!,
        full: paths.full!,
        vertical: paths.vertical!,
        landscape: paths.landscape!,
        thumb: paths.thumb!,
        root: paths.thumb!,
      };
    }
    installCatalogData(overlay, urls);
    activeCandidateId = overlay.candidateId;
    return {
      overlay,
      warning:
        [boot.warning, ...overlay.warnings].filter(Boolean).join(" ") || null,
    };
  } catch (error) {
    return {
      overlay: null,
      warning: `Using bundled catalog: ${errorText(error)}`,
    };
  }
}

export function createCatalogUpdater(options: Options) {
  let state: CatalogState = {
    phase: options.getEnabled() ? "idle" : "disabled",
    enabled: options.getEnabled(),
    busy: false,
    message: options.getEnabled()
      ? "Updates are checked in the background."
      : "Automatic updates are off.",
    error: null,
    checkedAt: null,
    completed: 0,
    total: 0,
    sourceCommit: activeCandidateId,
    warnings: [],
    optimizerNotice: null,
    preloads: null,
    preloadUnavailable: false,
  };
  let inFlight: Promise<CatalogState> | null = null,
    timer: ReturnType<typeof setTimeout> | null = null,
    disposed = false,
    pendingId: string | null = null;
  let optimizerBusy = false, preloadsBusy = false;
  let checkedCardIds: string[] | undefined;
  const snapshot = () => ({ ...state, busy: state.busy || optimizerBusy || preloadsBusy, warnings: [...state.warnings] });
  const publish = (patch: Partial<CatalogState>) => {
    state = { ...state, ...patch, enabled: options.getEnabled() };
    if (!disposed) options.onState(snapshot());
  };
  const canceled = (background: boolean) =>
    disposed || (background && !options.getEnabled());
  class Canceled extends Error {}
  const checkpoint = (background: boolean) => {
    if (canceled(background)) throw new Canceled();
  };
  async function run(background: boolean): Promise<CatalogState> {
    try {
      checkpoint(background);
      publish({
        phase: "checking",
        busy: true,
        message: "Checking for card updates…",
        error: null,
        completed: 0,
        total: 0,
      });
      const candidate = await options.invoke<CatalogCandidate>(
        "desktop_catalog_check",
      );
      checkpoint(background);
      const overlay = normalize(candidate);
      checkedCardIds = overlay.cards.map(card => card.id);
      const checkedAt =
        Number.isSafeInteger(candidate.checkedAt) && candidate.checkedAt > 0
          ? candidate.checkedAt
          : Date.now();
      publish({
        sourceCommit: overlay.sourceCommit,
        checkedAt,
        warnings: overlay.warnings,
      });
      if (candidate.candidateId === activeCandidateId) {
        publish({
          phase: "current",
          busy: false,
          message: "Card data is up to date.",
        });
        return snapshot();
      }
      if (candidate.candidateId === pendingId) {
        publish({
          phase: "ready",
          busy: false,
          message: "Card updates are ready. Reopen the app to apply them.",
        });
        return snapshot();
      }
      const records = { ...candidate.assets };
      let index = 0,
        completed = 0,
        failure: { error: unknown } | null = null;
      publish({
        phase: "downloading",
        message: "Preparing card artwork…",
        total: overlay.newAssetIds.length * 5,
      });
      const progress = () => publish({ completed: ++completed });
      const get = async (
        id: string,
        kind: Kind,
        needData = false,
      ): Promise<CatalogAsset> => {
        checkpoint(background);
        const key = `${kind}:${id}`,
          existing = records[key];
        if (validRecord(existing, id, kind) && (!needData || existing.data))
          return existing;
        const result = await options.invoke<CatalogAsset>(
          "desktop_catalog_asset",
          { id: overlay.candidateId, assetId: id, kind },
        );
        checkpoint(background);
        if (!validRecord(result, id, kind))
          throw Error("Downloaded card artwork failed validation.");
        records[key] = result;
        return result;
      };
      const prepare = async (id: string) => {
        // At most two cards run concurrently; sources are fetched sequentially so
        // network requests, decoded image frames and IPC payloads stay bounded.
        try {
          for (const kind of ["thumb", "full", "vertical"] as const) {
            await get(id, kind);
            progress();
          }
          for (const kind of ["grid", "landscape"] as const) {
            checkpoint(background);
            if (!validRecord(records[`${kind}:${id}`], id, kind)) {
              const source = await get(
                id,
                kind === "grid" ? "thumb" : "full",
                true,
              );
              const data = await deriveCatalogArtwork(source, kind);
              checkpoint(background);
              const result = await options.invoke<CatalogAsset>(
                "desktop_catalog_write_derived",
                { id: overlay.candidateId, assetId: id, kind, data },
              );
              checkpoint(background);
              if (!validRecord(result, id, kind))
                throw Error("Prepared card artwork failed validation.");
              records[`${kind}:${id}`] = result;
            }
            progress();
          }
        } finally {
          // Only two cards' encoded sources need to remain in memory. Keep the
          // metadata for completion checks and release base64 after resizing.
          for (const kind of kinds) {
            const key = `${kind}:${id}`,
              record = records[key];
            if (record?.data) {
              const { data, ...metadata } = record;
              records[key] = metadata;
            }
          }
        }
      };
      const worker = async () => {
        while (index < overlay.newAssetIds.length && !failure) {
          const id = overlay.newAssetIds[index++];
          try {
            await prepare(id);
          } catch (error) {
            failure = { error };
          }
        }
      };
      await Promise.all([worker(), worker()]);
      if (failure) throw (failure as { error: unknown }).error;
      checkpoint(background);
      const committed = await options.invoke<CatalogBootstrap>(
        "desktop_catalog_commit",
        { id: overlay.candidateId, normalizedAssetIds: overlay.assetIds },
      );
      if (
        !committed.candidate ||
        committed.candidate.candidateId !== overlay.candidateId
      )
        throw Error("Catalog update was not committed.");
      pendingId = overlay.candidateId;
      publish({
        phase: "ready",
        busy: false,
        message: "Card updates are ready. Reopen the app to apply them.",
        completed: state.total,
      });
      // Completion notifications are presentation callbacks. Their failure must
      // not turn an already durable, successful catalog commit into a save error.
      try {
        options.onReady?.(committed, overlay);
      } catch {}
      return snapshot();
    } catch (error) {
      if (error instanceof Canceled) {
        publish({
          phase: options.getEnabled() ? "idle" : "disabled",
          busy: false,
          message: options.getEnabled()
            ? "Updates are checked in the background."
            : "Automatic updates are off.",
        });
      } else
        publish({
          phase: "error",
          busy: false,
          message:
            "Could not check for card updates. Your current cards remain available.",
          error: catalogErrorText(error),
        });
      return snapshot();
    }
  }
  const checkUpdates = ({
    background = false,
  }: { background?: boolean } = {}) => {
    if (inFlight) return inFlight;
    if (disposed || (background && !options.getEnabled()))
      return Promise.resolve(snapshot());
    optimizerBusy = !!options.checkOptimizer;
    preloadsBusy = !!options.checkPreloads;
    const preloads = options.checkPreloads?.()
      .then(result => {
        if (!canceled(background)) publish({ preloads: result, preloadUnavailable: false });
      })
      .catch(() => {
        if (!canceled(background)) publish({ preloadUnavailable: true });
      })
      .finally(() => {
        preloadsBusy = false;
        publish({});
      });
    checkedCardIds = undefined;
    const optimizer = options.checkOptimizer?.(() => !canceled(background))
      .catch(error => ({ updated: false, catalogError: String(error), mobileError: null }));
    inFlight = Promise.all([run(background), optimizer, preloads]).then(async ([, result]) => {
      const missingCards = checkedCardIds && !canceled(background)
        ? await options.countCardsAwaitingOptimizer?.(checkedCardIds).catch(() => 0) : 0;
      optimizerBusy = false;
      if (!result || canceled(background)) { publish({}); return snapshot(); }
      const notices = [result.catalogError ? "Could not check for optimizer updates. The last verified catalog is still available." : null,
        missingCards ? `${missingCards} ${missingCards === 1 ? "card is" : "cards are"} awaiting optimizer data. New outfits and event options appear as their rules become available.` : null,
        result.mobileError ? "Could not check for updates to verified Mobile scoring data." : null];
      publish({ optimizerNotice: notices.filter(Boolean).join(" ") || null });
      if (result.updated) publish({message:state.phase==="ready"?
        "Optimizer data updated. Reload to apply the card catalog.":"Optimizer data updated."});
      return snapshot();
    }).finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
  const scheduleBackground = (delayMs = 1500) => {
    if (timer) clearTimeout(timer);
    if (!disposed && options.getEnabled())
      timer = setTimeout(
        () => {
          timer = null;
          void checkUpdates({ background: true });
        },
        Math.max(0, Math.min(60_000, delayMs)),
      );
    return () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
  };
  async function setEnabled(enabled: boolean) {
    await options.setEnabled(!!enabled);
    if (!enabled && timer) {
      clearTimeout(timer);
      timer = null;
    }
    publish({
      ...(state.busy || state.phase === "ready"
        ? {}
        : {
            phase: enabled ? "idle" : "disabled",
            message: enabled
              ? "Updates are checked in the background."
              : "Automatic updates are off.",
          }),
    });
    if (enabled) scheduleBackground();
  }
  function dispose() {
    disposed = true;
    if (timer) clearTimeout(timer);
    timer = null;
  }
  publish({});
  return {
    checkUpdates,
    scheduleBackground,
    setEnabled,
    getState: snapshot,
    restorePreloads: (preloads: PreloadStatus | null) => publish({ preloads }),
    dispose,
  };
}
