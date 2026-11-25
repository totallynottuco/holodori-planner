import {formatNumber} from './regional-formats.js';
import type {GameAccountSnapshot} from '../hololive/vendor/shared/types';

type MasterRows<T> = ReadonlyArray<{data: T}>;
type Named = {nameLangId?: string; order?: number};
type Lang = {id: string; text: string};
type Reward = {resourceId?: string; resourceType: string; quantity: string};
type CategoryRow = Named & {type: string};
type GroupRow = Named & {id: string; achievementCategoryType: string; assetId?: string; viewConditionGroupId?: string};
type MissionRow = Named & {id: string; achievementGroupId?: string; characterId?: string; descriptionLangId?: string; unprogressedNameLangId?: string; viewConditionGroupId?: string};
type TierRow = {missionId: string; threshold: string; rewards?: Reward[]; rewardCharacterExpQuantity?: string};
type MissionRows = NonNullable<GameAccountSnapshot['tables']['missions']>;

export interface AchievementMaster {
  AchievementCategory: MasterRows<CategoryRow>;
  AchievementGroup: MasterRows<GroupRow>;
  Mission: MasterRows<MissionRow>;
  MissionProgress: MasterRows<TierRow>;
  Item: MasterRows<Named & {id: string}>;
  Character: MasterRows<{id: string; nameEng?: string}>;
  LangAchievementCategory_Eng: MasterRows<Lang>;
  LangAchievementGroup_Eng: MasterRows<Lang>;
  LangMission_Eng: MasterRows<Lang>;
  LangItem_Eng: MasterRows<Lang>;
}

export interface AchievementTier {
  target: string;
  rewards: ReadonlyArray<{id: string; label: string; quantity: string}>;
}
export interface AchievementMission {
  id: string;
  title: string;
  unstartedTitle: string;
  description: string;
  tiers: AchievementTier[];
  viewCondition: string;
}
export interface AchievementGroup {
  id: string;
  name: string;
  icon: string;
  memberId: string;
  memberName: string;
  viewCondition: string;
  missions: AchievementMission[];
}
export interface AchievementCategory {id: string; name: string; groups: AchievementGroup[]}

export interface AchievementRewardOption {
  id: string;
  label: string;
  kind: 'item' | 'emblem' | 'outfit';
  families: string[];
}

type AchievementCatalog = {categories:AchievementCategory[]; rewardImages:Record<string,string>; rewards:AchievementRewardOption[]};
let catalogRequest: Promise<Readonly<AchievementCatalog>>|undefined;
export function loadAchievementCatalog() {
  catalogRequest ??= fetch('/assets/achievements/catalog.json').then(response => {
    if (!response.ok) throw new Error('Achievement catalog unavailable');
    return response.json().then((catalog:AchievementCatalog)=>Object.freeze(catalog));
  }).catch(error => {
    catalogRequest = undefined;
    throw error;
  });
  return catalogRequest;
}

export const achievementRewardFamilies = [
  {id:'any-cube',label:'Any Cube'},
  {id:'any-hexa',label:'Any Hexa'},
  {id:'cosmetics',label:'Cosmetics'},
  {id:'emblems',label:'Emblems'},
  {id:'park-outfits',label:'Park Outfits'},
] as const;

const hiddenCondition = 'cd-hidden-mission';
const byOrder = (a: Named, b: Named) => (a.order ?? 0) - (b.order ?? 0);
const byThreshold = (a: TierRow, b: TierRow) => BigInt(a.threshold) < BigInt(b.threshold) ? -1 : BigInt(a.threshold) > BigInt(b.threshold) ? 1 : 0;
const rewardLabels: Record<string, string> = {
  ResourceType_RESOURCE_TYPE_STONE_TOTAL: 'Diamonds',
  ResourceType_RESOURCE_TYPE_EMBLEM: 'Emblem',
  ResourceType_RESOURCE_TYPE_SD_COSTUME: 'Park Outfit',
};

function groupRows<T>(rows: MasterRows<T>, key: (row: T) => string | undefined): Map<string, T[]> {
  const indexed = new Map<string, T[]>();
  for (const {data} of rows) {
    const id = key(data);
    if (!id) continue;
    const group = indexed.get(id);
    if (group) group.push(data);
    else indexed.set(id, [data]);
  }
  return indexed;
}

export function buildAchievementCatalog(master: AchievementMaster): AchievementCategory[] {
  const labels = new Map([
    ...master.LangAchievementCategory_Eng, ...master.LangAchievementGroup_Eng,
    ...master.LangMission_Eng, ...master.LangItem_Eng,
  ].map(({data}) => [data.id, data.text]));
  const label = (id?: string) => id ? labels.get(id) ?? '' : '';
  const items = new Map(master.Item.map(({data}) => [data.id, label(data.nameLangId)]));
  const members = new Map(master.Character.map(({data}) => [data.id, data.nameEng ?? '']));
  const groups = groupRows(master.AchievementGroup, row => row.achievementCategoryType);
  const missions = groupRows(master.Mission, row => row.achievementGroupId);
  const tiers = groupRows(master.MissionProgress, row => row.missionId);
  return master.AchievementCategory.map(({data}) => data).sort(byOrder).map(category => ({
    id: category.type,
    name: label(category.nameLangId),
    groups: (groups.get(category.type) ?? []).filter(group => group.viewConditionGroupId !== hiddenCondition).sort(byOrder).map(group => {
      const rows = (missions.get(group.id) ?? []).filter(mission => mission.viewConditionGroupId !== hiddenCondition).sort(byOrder);
      const memberId = rows.find(mission => mission.characterId)?.characterId ?? '';
      return {
        id: group.id, name: label(group.nameLangId), icon: group.assetId ?? '', memberId,
        memberName: members.get(memberId) ?? '', viewCondition: group.viewConditionGroupId ?? '',
        missions: rows.map(mission => ({
          id: mission.id, title: label(mission.nameLangId), unstartedTitle: label(mission.unprogressedNameLangId),
          description: label(mission.descriptionLangId), viewCondition: mission.viewConditionGroupId ?? '',
          tiers: (tiers.get(mission.id) ?? []).sort(byThreshold).map(tier => ({
            target: tier.threshold,
            rewards: [
              ...(tier.rewards ?? []).map(reward => ({
                id: reward.resourceId || reward.resourceType,
                label: items.get(reward.resourceId ?? '') || rewardLabels[reward.resourceType] || 'Reward',
                quantity: reward.quantity,
              })),
              ...(tier.rewardCharacterExpQuantity && tier.rewardCharacterExpQuantity !== '0'
                ? [{id: 'character-exp', label: 'Holomem EXP', quantity: tier.rewardCharacterExpQuantity}]
                : []),
            ],
          })),
        })),
      };
    }),
  }));
}

export function indexAchievementProgress(missions?: MissionRows) {
  if (missions === undefined) return null;
  return new Map(missions.filter(row => row.missionPassId === '__NONE__').map(row => [row.missionId, row]));
}

/** One option per actual resource ID. Cosmetic entries use their unlock
 * objective as context because the achievement tables only label their type. */
export function buildAchievementRewardCatalog(categories: AchievementCategory[]): AchievementRewardOption[] {
  const options = new Map<string, AchievementRewardOption>();
  for (const category of categories) for (const group of category.groups) for (const mission of group.missions) {
    for (const tier of mission.tiers) for (const reward of tier.rewards) {
      if (options.has(reward.id)) continue;
      const kind = reward.id.startsWith('emblem-') ? 'emblem' : reward.id.startsWith('sdcos-') ? 'outfit' : 'item';
      const families: string[] = [];
      let label = reward.label;
      if (kind === 'item') {
        const material = reward.id.match(/^item-skill_tree_.+-([123])$/);
        if (material) families.push(material[1] === '2' ? 'any-hexa' : 'any-cube');
      } else {
        families.push('cosmetics',kind === 'emblem' ? 'emblems' : 'park-outfits');
        const objective = (mission.unstartedTitle || mission.title || mission.description)
          .replaceAll('{0}',formatNumber(BigInt(tier.target))).replace(/<[^>]+>/g,'');
        label = [group.name,objective].filter(Boolean).join(' · ');
      }
      options.set(reward.id,{id:reward.id,label,kind,families});
    }
  }
  return [...options.values()].sort((left,right) => left.label.localeCompare(right.label,'en'));
}

export function achievementProgress(mission: AchievementMission, source: ReturnType<typeof indexAchievementProgress>,missingUnknown=false) {
  const row = source?.get(mission.id);
  const progress = source === null ? null : row?.progress ?? (missingUnknown?null:'0');
  const received = new Set(row?.rewardReceivedThresholds);
  const value = progress === null ? null : BigInt(progress);
  const tiers = mission.tiers.map(tier => ({
    ...tier,
    status: value === null ? 'unknown' as const
      : received.has(tier.target) ? 'received' as const
      : value >= BigInt(tier.target) ? 'claimable' as const : 'incomplete' as const,
  }));
  return {progress, tiers};
}
