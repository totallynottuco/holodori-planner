/** Public master-data normalization. No network, renderer, profile mutation or
 * inference of ownership. Unknown mechanics fail before cache activation.
 */
import type {
  CardCatalogEntry,
  CardStat,
  ProgressionManifest,
  Rarity,
} from "../hololive/vendor/shared/types";
import type { accountManifest } from "../hololive/vendor/shared/account-data";
type Account = typeof accountManifest;
type Row = {
  id?: unknown;
  group_id?: unknown;
  level?: unknown;
  limit_break_count?: unknown;
  data: Record<string, unknown>;
};
export type CatalogAsset = {
  assetId: string;
  kind: string;
  path: string;
  sha256: string;
  bytes: number;
  width: number;
  height: number;
  data?: string;
};
export type CatalogCandidate = {
  schema: 1;
  candidateId: string;
  sourceCommit: string;
  checkedAt: number;
  tables: Record<string, unknown>;
  assets: Record<string, CatalogAsset>;
};
export type CatalogOverlay = Pick<
  Account,
  | "characters"
  | "productions"
  | "groups"
  | "memberLevelGroups"
  | "cardParameterProfiles"
  | "cardLevelBases"
  | "cardPotentialParameterBonuses"
  | "cardConnectEffectIds"
  | "connectEffects"
  | "connectExtents"
  | "costumes"
  | "templates"
> & {
  candidateId: string;
  sourceCommit: string;
  catalogVersion: string;
  cards: CardCatalogEntry[];
  cumulativeExperience: number[];
  rarities: ProgressionManifest["rarities"];
  newAssetIds: string[];
  assetIds: string[];
  sourceAssetTypes: Record<string, string>;
  warnings: string[];
};
const assetPattern = /^[A-Za-z0-9_-]{1,120}$/;
const string = (value: unknown, label: string) => {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 1000 ||
    /[\u0000-\u001f<>]/u.test(value)
  )
    throw Error(`Invalid ${label}.`);
  return value.trim();
};
const integer = (
  value: unknown,
  label: string,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
) => {
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    String(value).trim() === ""
  )
    throw Error(`Invalid ${label}.`);
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw Error(`Invalid ${label}.`);
  return n;
};
const enumeration = (value: unknown, label: string, values: number[]) => {
  const n = Number(String(value).match(/(?:^|_)(\d+)$/u)?.[1]);
  if (!values.includes(n)) throw Error(`Unsupported ${label}.`);
  return n;
};
const masterKey = (value: unknown, label: string) => {
  const key = string(value, label);
  if (["__proto__", "constructor", "prototype"].includes(key))
    throw Error(`Invalid ${label}.`);
  return key;
};
const idOf = (row: Row) => masterKey(row.id ?? row.data.id, "master ID");
const groupOf = (row: Row) =>
  masterKey(row.group_id ?? row.data.groupId, "master group");
function rows(candidate: CatalogCandidate, name: string): Row[] {
  const value = candidate.tables[name];
  if (!Array.isArray(value) || value.length > 200_000)
    throw Error(`Missing or oversized ${name} table.`);
  return value.map((row) => {
    if (
      !row ||
      typeof row !== "object" ||
      !row.data ||
      typeof row.data !== "object" ||
      Array.isArray(row.data)
    )
      throw Error(`Invalid ${name} row.`);
    return row as Row;
  });
}
function unique(rows: Row[], label: string) {
  const result = new Map<string, Row>();
  for (const row of rows) {
    const id = idOf(row);
    if (result.has(id)) throw Error(`Duplicate ${label} ID.`);
    result.set(id, row);
  }
  return result;
}
function language(candidate: CatalogCandidate, name: string) {
  return new Map(
    [...unique(rows(candidate, name), name)].map(([id, row]) => [
      id,
      String(row.data.text ?? ""),
    ]),
  );
}
function sequence<T extends { level: number }>(values: T[], label: string) {
  values.sort((a, b) => a.level - b.level);
  if (
    !values.length ||
    values.some((value, index) => value.level !== index + 1)
  )
    throw Error(`Noncontiguous ${label}.`);
  return values;
}

export function normalizeCatalogCandidate(
  candidate: CatalogCandidate,
  baseline: ProgressionManifest,
  account: Account,
): CatalogOverlay {
  if (
    candidate.schema !== 1 ||
    !/^[a-f0-9]{40}$/iu.test(candidate.candidateId) ||
    candidate.sourceCommit !== candidate.candidateId
  )
    throw Error("Invalid catalog update identity.");
  const cardRows = unique(rows(candidate, "Card"), "Card"),
    characterRows = unique(rows(candidate, "Character"), "Character");
  if (!cardRows.size || cardRows.size > 10000)
    throw Error("Unsupported card catalog size.");
  for (const card of baseline.cards)
    if (!cardRows.has(card.id))
      throw Error("Catalog update omits an existing card.");
  const names = language(candidate, "LangCard_Eng"),
    groupNames = language(candidate, "LangCharacterGrouping_Eng"),
    productionNames = language(candidate, "LangCharacterProduction_Eng"),
    costumeNames = language(candidate, "LangCostume_Eng");
  const groupRows = unique(
    rows(candidate, "CharacterGrouping"),
    "CharacterGrouping",
  );
  const memberIds = new Set(
    [...cardRows.values()].map((row) =>
      string(row.data.characterId, "card member ID"),
    ),
  );
  const memberLevelRows = rows(candidate, "CharacterLevel");
  const memberLevelGroups: Account["memberLevelGroups"] = {};
  for (const row of memberLevelRows) {
    const group = groupOf(row);
    (memberLevelGroups[group] ??= []).push({
      level: integer(row.data.level ?? row.level, "member level", 1, 50),
      experience: integer(row.data.exp ?? 0, "member EXP"),
      boardPointsEarned: integer(
        row.data.skillTreePointQuantity ?? 0,
        "Board points",
      ),
      cumulativeBoardPoints: 0,
    });
  }
  for (const [group, levels] of Object.entries(memberLevelGroups)) {
    sequence(levels, `member levels ${group}`);
    let points = 0;
    for (const row of levels) {
      points = integer(
        points + row.boardPointsEarned,
        "cumulative Board points",
      );
      row.cumulativeBoardPoints = points;
    }
    if (
      levels.some(
        (row, index) =>
          index > 0 && row.experience <= levels[index - 1].experience,
      )
    )
      throw Error("Member EXP thresholds must increase.");
  }
  const groups: Account["groups"] = [];
  for (const [id, row] of groupRows) {
    if (row.data.isRegular !== true || !Array.isArray(row.data.characterIds))
      continue;
    const members = row.data.characterIds
      .map((value) => string(value, "group member"))
      .filter((id) => memberIds.has(id));
    if (!members.length) continue;
    const name =
      groupNames.get(string(row.data.nameLangId, "group label ID")) ??
      account.groups.find((group) => group.id === id)?.name;
    if (!name) throw Error("Missing English group label.");
    groups.push({
      id,
      name,
      order: integer(row.data.order ?? 0, "group order"),
      characterIds: members,
    });
  }
  groups.sort((a, b) => a.order - b.order);
  const groupsById = new Map(groups.map((group) => [group.id, group]));
  const productions: Account["productions"] = [];
  for (const [id, row] of unique(
    rows(candidate, "CharacterProduction"),
    "CharacterProduction",
  )) {
    const name =
      productionNames.get(string(row.data.nameLangId, "production label ID")) ??
      account.productions.find((production) => production.id === id)?.name;
    if (!name) throw Error("Missing English production label.");
    productions.push({
      id,
      name,
      order: integer(row.data.order ?? 0, "production order"),
    });
  }
  productions.sort((a, b) => a.order - b.order);
  const characters: Account["characters"] = [];
  for (const id of memberIds) {
    const row = characterRows.get(id);
    if (!row || row.data.isPlayable !== true)
      throw Error("Card references an unknown playable member.");
    const d = row.data,
      levelGroupId = string(d.characterLevelGroupId, "member level group");
    const levels = memberLevelGroups[levelGroupId];
    if (!levels) throw Error("Missing member level progression.");
    const groupIds = Array.isArray(d.regularCharacterGroupingIds)
      ? d.regularCharacterGroupingIds.map((value) =>
          string(value, "member group ID"),
        )
      : [];
    if (!groupIds.length || groupIds.some((group) => !groupsById.has(group)))
      throw Error("Missing member group.");
    characters.push({
      id,
      name: string(d.nameEng, "member name"),
      shortName: string(d.shortNameEng ?? d.nameEng, "short member name"),
      assetId: string(d.assetId, "member asset ID"),
      productionId: string(d.characterProductionId, "member production"),
      rosterOrder: integer(d.order ?? 0, "roster order"),
      levelGroupId,
      maximumLevel: levels.at(-1)!.level,
      boardTemplateId: string(d.skillTreeNodePositionGroupId, "Board template"),
      boardPointId: string(d.skillTreePointId, "Board point ID"),
      groupIds,
      defaultCostumeId: string(d.defaultCostumeId, "default outfit"),
    });
  }
  characters.sort((a, b) => a.name.localeCompare(b.name));
  const charactersById = new Map(
    characters.map((character) => [character.id, character]),
  );
  // Boards are deferred. Keep the reviewed baseline layouts exactly; raw new
  // positions remain in the cached candidate without inventing node semantics.
  const templates: Account["templates"] = structuredClone(account.templates),
    warnings: string[] = [];
  const unsupportedNodes = new Set<string>();
  for (const row of rows(candidate, "SkillTreeNodePosition")) {
    groupOf(row);
    const nodeGroupId = string(
      row.data.skillTreeNodeGroupId,
      "Board node group",
    );
    integer(row.data.positionX ?? 0, "Board x", -1000, 1000);
    integer(row.data.positionY ?? 0, "Board y", -1000, 1000);
    if (!account.nodeGroups[nodeGroupId]) unsupportedNodes.add(nodeGroupId);
  }
  if (unsupportedNodes.size)
    warnings.push(
      "Some new Board definitions are unavailable; reviewed Board calculations are retained.",
    );
  if (
    characters.some(
      (character) =>
        !templates.some(
          (template) => template.id === character.boardTemplateId,
        ),
    )
  )
    warnings.push("Board layouts for new members are unavailable.");
  const levelRows = rows(candidate, "CardLevel"),
    cardLevelBases: Account["cardLevelBases"] = {},
    xpGroups = new Map<string, Array<{ level: number; exp: number }>>();
  for (const row of levelRows) {
    const group = groupOf(row),
      level = integer(row.data.level ?? row.level, "card level", 1, 80);
    (cardLevelBases[group] ??= []).push({
      level,
      parameterBaseValue: integer(
        row.data.parameterBaseValue,
        "card parameter base",
        1,
      ),
    });
    let xp = xpGroups.get(group);
    if (!xp) xpGroups.set(group, (xp = []));
    xp.push({ level, exp: integer(row.data.exp ?? 0, "card EXP") });
  }
  for (const [group, levels] of Object.entries(cardLevelBases))
    sequence(levels, `card parameter levels ${group}`);
  for (const [group, levels] of xpGroups) sequence(levels, `card EXP ${group}`);
  const complete = [...xpGroups.values()].find(
    (levels) => levels.length === 80,
  );
  if (!complete) throw Error("Missing complete card EXP curve.");
  const cumulativeExperience = complete.map((row) => row.exp);
  if (
    cumulativeExperience[0] !== 0 ||
    cumulativeExperience.some(
      (value, index) => index > 0 && value <= cumulativeExperience[index - 1],
    )
  )
    throw Error("Invalid cumulative card EXP.");
  for (const levels of xpGroups.values())
    for (const row of levels)
      if (row.exp !== cumulativeExperience[row.level - 1])
        throw Error("Different card EXP curves require an app update.");
  const potentialRows = rows(candidate, "CardPotential"),
    cardPotentialParameterBonuses: Account["cardPotentialParameterBonuses"] =
      {};
  for (const row of potentialRows) {
    const group = groupOf(row);
    cardPotentialParameterBonuses[group] ??= [];
    const effect = String(row.data.effectType).replace(
      "CardPotentialEffectType_CARD_POTENTIAL_EFFECT_TYPE_",
      "",
    );
    if (
      ![
        "ACTIVE_SKILL_LEVEL_UP",
        "ALL_PARAMETER_UP_PERMIL_UP",
        "SPECIAL_SKILL_LEVEL_UP",
        "PASSIVE_SKILL_LEVEL_UP",
        "SKILL_TREE_CONNECT_EFFECT_LEVEL_UP",
      ].includes(effect)
    )
      throw Error("New Bloom mechanics require an app update.");
    if (effect !== "ALL_PARAMETER_UP_PERMIL_UP") continue;
    cardPotentialParameterBonuses[group].push({
      bloomStage: integer(row.data.upgradeCount, "Bloom stage", 1, 5),
      permil: integer(row.data.value, "Bloom parameter bonus"),
    });
  }
  for (const [group, bonuses] of Object.entries(
    cardPotentialParameterBonuses,
  )) {
    bonuses.sort((a, b) => a.bloomStage - b.bloomStage);
    const stages = potentialRows
      .filter((row) => groupOf(row) === group)
      .map((row) => integer(row.data.upgradeCount, "Bloom stage", 1, 5))
      .sort((a, b) => a - b);
    if (
      stages.length !== 5 ||
      stages.some((stage, index) => stage !== index + 1)
    )
      throw Error("Bloom stage layout changed.");
  }
  const rarities = {} as ProgressionManifest["rarities"];
  const limitRows = rows(candidate, "CardLevelLimit");
  for (const rarity of [3, 4, 5] as const) {
    let expected: ProgressionManifest["rarities"]["3"] | null = null;
    for (const attribute of [1, 2, 3]) {
      const levels = limitRows
        .filter(
          (row) => groupOf(row) === `rarity_${rarity}-attribute_${attribute}`,
        )
        .sort(
          (a, b) =>
            Number(a.limit_break_count ?? a.data.limitBreakCount ?? 0) -
            Number(b.limit_break_count ?? b.data.limitBreakCount ?? 0),
        );
      if (levels.length !== 5) throw Error("SP stage layout changed.");
      if (
        levels.some(
          (row, index) =>
            integer(
              row.limit_break_count ?? row.data.limitBreakCount ?? 0,
              "SP stage",
              0,
              4,
            ) !== index ||
            (index > 0 &&
              Number(row.data.levelLimit) <=
                Number(levels[index - 1].data.levelLimit)),
        )
      )
        throw Error("SP stage layout changed.");
      const result = {
        initialLevelCap: integer(
          levels[0].data.levelLimit,
          "initial level cap",
          1,
          80,
        ),
        maxLevel: integer(levels[4].data.levelLimit, "maximum level", 1, 80),
        trainingStages: levels.slice(1).map((row, index) => {
          const cost = { beads: 0, crystals: 0, hololium: 0, hologold: 0 };
          if (!Array.isArray(row.data.consumptions))
            throw Error("Missing SP costs.");
          for (const item of row.data.consumptions as Record<
            string,
            unknown
          >[]) {
            const resource = string(item.resourceId, "SP material ID"),
              quantity = integer(item.quantity, "SP quantity");
            if (resource === "item-gold") cost.hologold += quantity;
            else if (resource === "item-card_limit_break-cmn-sr")
              cost.hololium += quantity;
            else if (
              resource === `item-card_limit_break-attribute_${attribute}-1`
            )
              cost.beads += quantity;
            else if (
              resource === `item-card_limit_break-attribute_${attribute}-2`
            )
              cost.crystals += quantity;
            else throw Error("Unknown SP material requires an app update.");
          }
          for (const quantity of Object.values(cost))
            integer(quantity, "total SP cost");
          return {
            stage: (index + 1) as 1 | 2 | 3 | 4,
            levelCap: integer(row.data.levelLimit, "SP level cap", 1, 80),
            cost,
          };
        }),
      };
      if (expected && JSON.stringify(expected) !== JSON.stringify(result))
        throw Error("Attribute-dependent SP costs require an app update.");
      expected = result;
    }
    rarities[String(rarity) as "3" | "4" | "5"] = expected!;
  }
  const cards: CardCatalogEntry[] = [],
    cardParameterProfiles: Account["cardParameterProfiles"] = {},
    cardConnectEffectIds: Account["cardConnectEffectIds"] = {},
    sourceAssetTypes: Record<string, string> = {};
  const baselineById = new Map(baseline.cards.map((card) => [card.id, card]));
  const assetIds = new Set<string>();
  for (const [id, row] of cardRows) {
    const d = row.data,
      member = charactersById.get(string(d.characterId, "card member"));
    if (!member) throw Error("Missing card member.");
    const assetId = string(d.assetId, "card asset ID");
    if (!assetPattern.test(assetId) || assetIds.has(assetId))
      throw Error("Invalid or duplicate card asset ID.");
    assetIds.add(assetId);
    const rarity = enumeration(d.rarity, "rarity", [3, 4, 5]) as Rarity;
    const attribute = ({ 1: "cute", 2: "pure", 3: "happy" } as const)[
      enumeration(d.attributeType, "attribute", [1, 2, 3]) as 1 | 2 | 3
    ];
    const parameterPermil = {
      performance: integer(d.performancePermilMultiply, "Performance ratio"),
      technique: integer(d.techniquePermilMultiply, "Technique ratio"),
      sense: integer(d.sensePermilMultiply, "Sense ratio"),
    };
    const weights = Object.entries(parameterPermil).sort((a, b) => b[1] - a[1]);
    if (
      weights[0][1] === weights[1][1] ||
      weights.reduce((sum, [, value]) => sum + value, 0) !== 1000
    )
      throw Error("Unsupported card stat ratios.");
    const cardName = names.get(string(d.nameLangId, "card name ID"));
    if (!cardName) throw Error("Missing English card name.");
    string(cardName, "English card name");
    const levelGroupId = string(d.cardLevelGroupId, "card level group"),
      potentialGroupId = string(d.cardPotentialGroupId, "card potential group");
    if (
      !cardLevelBases[levelGroupId] ||
      !cardPotentialParameterBonuses[potentialGroupId]
    )
      throw Error("Missing card parameter progression.");
    if (
      cardLevelBases[levelGroupId].at(-1)!.level !==
      rarities[String(rarity) as "3" | "4" | "5"].maxLevel
    )
      throw Error("Card parameter curve does not match its level cap.");
    const groupId = member.groupIds[0];
    const previous = baselineById.get(id);
    const groupLabel =
      baseline.cards.find((card) => card.groupId === groupId)?.groupLabel ??
      groupsById.get(groupId)!.name;
    cards.push({
      id,
      catalogOrder: typeof d.order === 'number' && Number.isSafeInteger(d.order) && d.order > 0 ? d.order : previous?.catalogOrder,
      assetId,
      memberName: member.name,
      cardName,
      rarity,
      attribute,
      stat: weights[0][0] as CardStat,
      groupId,
      groupLabel,
      animation: previous?.assetId === assetId ? previous.animation : null,
    });
    cardParameterProfiles[id] = {
      cardId: id,
      characterId: member.id,
      attribute,
      levelGroupId,
      potentialGroupId,
      parameterPermil,
    };
    sourceAssetTypes[id] = string(d.assetType, "card asset type");
    if (d.skillTreeConnectEffectId)
      cardConnectEffectIds[id] = string(
        d.skillTreeConnectEffectId,
        "Connect effect",
      );
  }
  cards.sort(
    (a, b) =>
      a.memberName.localeCompare(b.memberName) ||
      b.rarity - a.rarity ||
      a.cardName.localeCompare(b.cardName),
  );
  const connectLanguage = language(
      candidate,
      "LangGeneratedSkillTreeConnectEffect_Eng",
    ),
    connectRows = rows(candidate, "SkillTreeConnectEffect"),
    connectEffects: Account["connectEffects"] = {},
    connectExtents: Account["connectExtents"] = {};
  for (const row of connectRows) {
    const id = idOf(row),
      extentGroupId = string(
        row.data.skillTreeConnectEffectExtentGroupId,
        "Connect extent",
      );
    let effect = connectEffects[id];
    if (!effect)
      connectEffects[id] = effect = { id, extentGroupId, levels: [] };
    if (effect.extentGroupId !== extentGroupId)
      throw Error("Inconsistent Connect extents.");
    const level = integer(row.data.level, "Connect level", 1, 2) as 1 | 2;
    const description = connectLanguage.get(
      string(row.data.descriptionLangId, "Connect description"),
    );
    if (!description) throw Error("Missing Connect description.");
    effect.levels.push({
      level,
      effectPermilUp: integer(
        row.data.effectPermilUp,
        "Connect amplification",
        1,
      ),
      description: description
        .replaceAll("[highlight]", "")
        .replaceAll("[/highlight]", ""),
    });
  }
  for (const effect of Object.values(connectEffects)) {
    sequence(effect.levels, "Connect levels");
    if (effect.levels.length !== 2) throw Error("Connect level count changed.");
  }
  for (const row of rows(candidate, "SkillTreeConnectEffectExtent")) {
    const group = groupOf(row);
    (connectExtents[group] ??= []).push({
      x: integer(row.data.positionX ?? 0, "Connect x", -1000, 1000),
      y: integer(row.data.positionY ?? 0, "Connect y", -1000, 1000),
    });
  }
  for (const effect of Object.values(connectEffects))
    if (!connectExtents[effect.extentGroupId]?.length)
      throw Error("Missing Connect extent.");
  for (const id of Object.values(cardConnectEffectIds))
    if (!connectEffects[id]) throw Error("Missing card Connect effect.");
  const sourceCards = new Map<string, string>();
  for (const [id, row] of cardRows) {
    if (row.data.rewardCostumeId)
      sourceCards.set(string(row.data.rewardCostumeId, "reward outfit"), id);
    if (enumeration(row.data.rarity, "rarity", [3, 4, 5]) === 3)
      sourceCards.set(
        charactersById.get(string(row.data.characterId, "member"))!
          .defaultCostumeId,
        id,
      );
  }
  const costumes: Account["costumes"] = [];
  for (const [id, row] of unique(rows(candidate, "Costume"), "Costume")) {
    const d = row.data,
      characterId = string(d.characterId, "outfit member");
    if (!charactersById.has(characterId)) continue;
    const name = costumeNames.get(string(d.nameLangId, "outfit label"));
    if (!name) throw Error("Missing outfit label.");
    const sourceCardId = sourceCards.get(id);
    if (!sourceCardId) continue;
    costumes.push({
      id,
      characterId,
      name,
      assetId: string(d.assetId, "outfit asset"),
      leaderSkillId: d.liveLeaderSkillId
        ? string(d.liveLeaderSkillId, "leader skill")
        : null,
      rarity: enumeration(d.rarityType, "outfit rarity", [0, 3, 4, 5]),
      isDefault: charactersById.get(characterId)!.defaultCostumeId === id,
      sourceCardId,
    });
  }
  const baselineAssets = new Set(baseline.cards.map((card) => card.assetId));
  return {
    candidateId: candidate.candidateId,
    sourceCommit: candidate.sourceCommit,
    catalogVersion: `public-${candidate.sourceCommit.slice(0, 12)}`,
    cards,
    cumulativeExperience,
    rarities,
    cardParameterProfiles,
    cardLevelBases,
    cardPotentialParameterBonuses,
    cardConnectEffectIds,
    connectEffects,
    connectExtents,
    characters,
    productions,
    groups,
    memberLevelGroups,
    costumes,
    templates,
    assetIds: [...assetIds],
    newAssetIds: [...assetIds].filter((id) => !baselineAssets.has(id)),
    sourceAssetTypes,
    warnings,
  };
}

/** Derive both compact images from the complete downloaded source frames. */
export async function deriveCatalogArtwork(
  source: CatalogAsset,
  kind: "grid" | "landscape",
) {
  if (!source.data || source.kind !== (kind === "grid" ? "thumb" : "full"))
    throw Error("Missing original card artwork.");
  const bytes = Uint8Array.from(atob(source.data), (value) =>
    value.charCodeAt(0),
  );
  const bitmap = await createImageBitmap(
    new Blob([bytes], { type: "image/webp" }),
  );
  try {
    const width = kind === "grid" ? 256 : 455,
      height = 256;
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) throw Error("Image resize is unavailable.");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, width, height);
    const blob = await canvas.convertToBlob({
      type: "image/webp",
      quality: 0.8,
    });
    if (blob.type !== "image/webp")
      throw Error("WebP conversion is unavailable.");
    const result = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let i = 0; i < result.length; i += 8192)
      binary += String.fromCharCode(...result.subarray(i, i + 8192));
    return btoa(binary);
  } finally {
    bitmap.close();
  }
}
