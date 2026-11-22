import { accountCharactersById, accountCostumesById, createScoringAccountScope, resolveBoardNodes, resolveBoardConnectEffect } from '../hololive/vendor/shared/account-data';
import { resolveChartTimeline } from '../hololive/vendor/shared/chart-timeline';
import { resolveExpectedScoreTrace } from '../hololive/vendor/shared/expected-score-trace';
import { decodeOptimizerChart, type OptimizerDecodedChart } from '../hololive/vendor/shared/optimizer-chart-pack';
import { progressionManifest } from '../hololive/vendor/shared/manifest';
import { minimumTrainingStage } from '../hololive/vendor/shared/planner';
import { createDefaultCardState, createDefaultProfile } from '../hololive/vendor/shared/profile';
import type { CardCatalogEntry } from '../hololive/vendor/shared/types';
import { compileExpectedScoreDistribution } from '../hololive/vendor/shared/score-distribution-plan';
import { simulateScoreRuns } from '../hololive/vendor/shared/score-distribution';
import { loadOptimizerResources, type MobileScoringSource } from './team-optimizer-resources';

type Entry = { level: number; bloom: number; sp?: number };
type CardRarity = Pick<CardCatalogEntry, 'id' | 'rarity'>;
type Board = { nodes: string[]; cards: Record<string, string> };
type Scenario = {
  account: { owned: Record<string, Entry>; boards: Record<string, Board>; ranks: Record<string, number> };
  options: { scoringMode: 'chart' | 'generic'; memories: number; powerUpOverride?: number; pc?: boolean;
    boardConnectEntries?: Record<string, Entry> };
};
type SelectedChart = { key: string; level: number; notes: number };
type Team = {
  order: string[];
  leaderChar: string;
  outfitId: string;
  lineup: Entry[];
  entries?: Record<string, Entry>;
  powerUpOverride?: number;
  boards?: Record<string, Board>;
  plan?: { saves?: Record<string, Board>; ranks?: Record<string, number> };
};

const decimal = ({ numerator, denominator }: { numerator: string; denominator: string }) =>
  Number(BigInt(numerator) * 1000n / BigInt(denominator)) / 1000;

/** Score each exact order, outfit and Board scenario using the recovered Mobile routines. */
export async function prepareReviewedOptimizer(scenario: Scenario, memoryPermil: number | undefined, selectedCharts: SelectedChart[], source?: MobileScoringSource, cards: CardRarity[] = progressionManifest.cards) {
  const { pack, data, denominators, account: reviewedAccount } = await loadOptimizerResources(source);
  const scoped = createScoringAccountScope(reviewedAccount);
  const withAccount = <Args extends unknown[], Result>(run: (...args: Args) => Result) =>
    (...args: Args) => scoped(() => run(...args));
  const { account, options } = scenario;
  if (!selectedCharts.length || selectedCharts.some(({ key, level, notes }) => {
    const row = pack.rowsByKey.get(key);
    return !row || row[2] !== level || row[5] !== notes || !denominators.get(key);
  })) return null;
  const charts = selectedCharts.map(({ key }) => decodeOptimizerChart(pack, key, options.pc ? 'pc' : 'mobile'));
  const chartsByKey = new Map(charts.map(chart => [chart.key, chart]));
  const cardRarities = new Map(cards.map(card => [card.id, card]));
  function cardState(id: string, entry: Entry) {
    const state = createDefaultCardState(id, id);
    state.level = entry.level;
    state.bloomStage = entry.bloom as typeof state.bloomStage;
    const card = cardRarities.get(id);
    if (card && entry.level <= progressionManifest.rarities[card.rarity].maxLevel) {
      const rules=progressionManifest.rarities[card.rarity];
      state.trainingStage = Math.min(rules.trainingStages.length,Math.max(entry.sp??0,
        minimumTrainingStage(card, entry.level, progressionManifest))) as typeof state.trainingStage;
    }
    return state;
  }
  const base = createDefaultProfile(data.metadata.catalogVersion);
  base.account.memoriesCollected = options.memories;
  base.account.unlockedCharacterIds = scoped(() => Object.keys(account.ranks).filter(id => accountCharactersById.has(id)));
  for (const [id, entry] of Object.entries({...options.boardConnectEntries,...account.owned})) {
    base.cards[id] = cardState(id, entry);
  }
  const observed = { memoryPermil, upgradePermyriad: options.powerUpOverride };
  const reviewedBoards = new WeakSet<Scenario['account']['boards']>();
  const nodesByMember = new Map<string, Map<string, ReturnType<typeof resolveBoardNodes>[number]>>();

  function verifyBoards(boards: Scenario['account']['boards'], entries?: Team['entries']) {
    if (!entries && reviewedBoards.has(boards)) return;
    for (const [member, board] of Object.entries(boards)) {
      if (!board.nodes.length && !Object.keys(board.cards).length) continue;
      let nodes = nodesByMember.get(member);
      if (!nodes) {
        nodes = new Map(resolveBoardNodes(member).map(node => [node.groupId, node]));
        nodesByMember.set(member, nodes);
      }
      if (board.nodes.some(id => !nodes.has(id))) throw Error('An unlocked node is outside the reviewed Mobile Board catalog.');
      for (const [slot, card] of Object.entries(board.cards)) {
        const entry = entries?.[card] ?? account.owned[card] ?? options.boardConnectEntries?.[card];
        if (!nodes.has(slot) || !entry || !resolveBoardConnectEffect(card, entry.bloom))
          throw Error('A Connect assignment is outside the reviewed Mobile Board catalog.');
      }
    }
    if (!entries) reviewedBoards.add(boards);
  }

  function profileFor(team: Team) {
    const outfit = accountCostumesById.get(team.outfitId);
    if (!outfit || !accountCharactersById.has(team.leaderChar))
      throw Error('Leader or outfit is outside the reviewed scoring catalog.');
    const ranks = team.plan?.ranks ?? account.ranks;
    const boards = team.plan?.saves ?? team.boards ?? account.boards;
    verifyBoards(boards, team.entries);
    const profile = {
      ...base,
      cards: { ...base.cards },
      account: {
        ...base.account,
        unlockedCharacterIds: [...new Set([...base.account.unlockedCharacterIds, team.leaderChar])],
        ownedCostumeIds: [team.outfitId],
        boards: Object.fromEntries(Object.entries(boards).filter(([, board]) => board.nodes.length || Object.keys(board.cards).length)
          .map(([id, board]) => [id, { characterId: id, characterLevel: ranks[id] ?? 1,
            unlockedNodeIds: board.nodes, connectAssignments: board.cards }])),
      },
    };
    for (const [id, entry] of Object.entries(team.entries ?? {})) profile.cards[id] = cardState(id, entry);
    for (const [index, id] of team.order.entries()) profile.cards[id] = cardState(id, team.lineup[index]);
    return profile;
  }

  function evaluate(team: Team, profile: ReturnType<typeof profileFor>, chart: OptimizerDecodedChart) {
    const bonuses=team.powerUpOverride===undefined?observed:{...observed,upgradePermyriad:team.powerUpOverride};
    const timeline = resolveChartTimeline(profile, {
      memberCardIds: team.order, leaderCharacterId: team.leaderChar, outfitId: team.outfitId, songId: chart.music_id,
    }, chart, data, null, bonuses);
    const trace = resolveExpectedScoreTrace(timeline, chart, data, denominators);
    const points = trace.expectedScenarioTotal;
    if (!points || trace.power.status !== 'resolved') {
      throw Error(trace.reasons.slice(0, 2).join('; ') || 'Some score effects are outside the reviewed model.');
    }
    return { timeline, trace, low: decimal(points.lower), high: decimal(points.upper), overallPower: trace.power.value };
  }

  function distribution(evaluation: ReturnType<typeof evaluate>, chart: OptimizerDecodedChart) {
    return compileExpectedScoreDistribution(evaluation.trace, chart, evaluation.timeline.team.song.scoreCoefficientPermil);
  }

  function scoreChart(team: Team, profile: ReturnType<typeof profileFor>, chart: OptimizerDecodedChart, averageOnly = false) {
    const evaluation = evaluate(team, profile, chart);
    const plan = averageOnly ? null : distribution(evaluation, chart);
    if (!averageOnly && !plan) throw Error('The modeled score bounds are unavailable.');
    return { low: evaluation.low, high: evaluation.high, average: (evaluation.low + evaluation.high) / 2,
      maximum: plan?.bounds.maximum.score ?? null, overallPower: evaluation.overallPower };
  }

  function requireChart(key: string) {
    const chart = chartsByKey.get(key);
    if (!chart) throw Error('This chart is outside the reviewed Mobile chart pack.');
    return chart;
  }

  return {
    previewSimulation: withAccount((team: Team, key: string) => {
      const chart = requireChart(key);
      const evaluation = evaluate(team, profileFor(team), chart);
      const plan = distribution(evaluation, chart);
      if (!plan) return null;
      const stride = Math.max(1, Math.ceil(evaluation.trace.groups.length / 60));
      const timeline = evaluation.trace.groups.flatMap((group, index, groups) =>
        (index % stride === 0 || index === groups.length - 1) && group.cumulativeExpectedPoints ? [{
          seconds: group.timeMicroseconds / 1_000_000,
          score: (decimal(group.cumulativeExpectedPoints.lower) + decimal(group.cumulativeExpectedPoints.upper)) / 2,
        }] : []);
      return {
        average: (evaluation.low + evaluation.high) / 2,
        minimum: plan.bounds.minimum.score,
        maximum: plan.bounds.maximum.score,
        timeline,
        sample: (runs: number) => simulateScoreRuns(plan, { seed: Math.floor(Math.random() * 2 ** 32), runs }).scoreCounts,
      };
    }),
    scoreCharts: withAccount((team: Team, keys: string[], averageOnly: boolean = false) => {
      const profile = profileFor(team);
      return keys.map(key => scoreChart(team, profile, requireChart(key), averageOnly));
    }),
    score: withAccount((team: Team) => {
      const profile = profileFor(team);
      let low = 0, high = 0, maximum = 0, overallPower = 0;
      for (const chart of charts) {
        const score = scoreChart(team, profile, chart);
        low += score.low;
        high += score.high;
        maximum += score.maximum!;
        overallPower += score.overallPower;
      }
      const count = charts.length;
      return { low: low / count, high: high / count, average: (low + high) / (2 * count),
        maximum: maximum / count, overallPower: overallPower / count,
        ...(options.scoringMode === 'generic' ? { chartCount: count } : {}) };
    }),
    details: withAccount((team: Team, key?: string) => {
      if (options.scoringMode !== 'chart') return null;
      const chart = key ? requireChart(key) : charts[0];
      const evaluation = evaluate(team, profileFor(team), chart);
      const plan = distribution(evaluation, chart);
      if (!plan) return null;
      const simulated = simulateScoreRuns(plan, { seed: 2718, runs: 512 });
      const stride = Math.max(1, Math.ceil(evaluation.trace.groups.length / 60));
      const groups = evaluation.trace.groups.filter((_, index, rows) => index % stride === 0 || index === rows.length - 1);
      return {
        minimum: plan.bounds.minimum.score, maximum: plan.bounds.maximum.score,
        histogram: simulated.histogram, percentiles: simulated.percentiles, runs: 512,
        timeline: groups.flatMap(group => group.cumulativeExpectedPoints ? [{
          seconds: group.timeMicroseconds / 1_000_000,
          score: (decimal(group.cumulativeExpectedPoints.lower) + decimal(group.cumulativeExpectedPoints.upper)) / 2,
        }] : []),
      };
    }),
  };
}

