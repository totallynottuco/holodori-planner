import {z} from 'zod';

const identifier=z.string().max(180).regex(/^[a-z0-9][a-z0-9_-]*$/i);
const difficulty=z.enum(['easy','normal','hard','expert']);
const board=z.object({nodes:z.array(identifier),cards:z.record(identifier,identifier)});
const level=z.number().int().min(1).max(80);
const bloom=z.number().int().min(0).max(5);
export const savedLineupSchema=z.object({
  id:z.string().uuid(),name:z.string().trim().min(1).max(80),
  cardIds:z.array(identifier).length(5).refine(ids=>new Set(ids).size===5),
  lineup:z.array(z.object({level,bloom,sp:z.number().int().min(0).max(4).optional()})).length(5),
  cardAssumptions:z.object({
    cardPool:z.enum(['ownedCustom','allCustom','allMaxed']),
    customLevel:level.nullable(),
    customBloom:bloom.nullable(),
    noDelevel:z.boolean(),noDebloom:z.boolean(),
  }).optional(),
  powerUpPreset:z.enum(['auto','search','allMax','ownedMax','owned']).optional(),
  plannedCards:z.array(z.object({cardId:identifier,level,potentialUpgradeCount:bloom,
    levelLimitBreakCount:z.number().int().min(0).max(4)})).optional(),
  leaderChar:identifier,outfitId:identifier.nullable(),
  outfitAssumption:z.object({outfitId:identifier,cardId:identifier,level,bloom}).optional(),
  objective:z.enum(['score','unitScore','event','eventPoints','holomemLb']),
  charts:z.array(z.object({songId:identifier,difficulty})),
  pc:z.boolean(),anyDiffMin:z.number().int(),anyDiffMax:z.number().int(),anyDiffTypes:z.array(difficulty).optional(),
  sortBy:z.enum(['avg','max']),eventId:identifier.optional(),eventChapter:z.number().int().positive().optional(),
  liveBoost:z.number().int().min(1).max(10),
  boardMode:z.enum(['none','imported','saved','optimize']),boards:z.record(identifier,board),
  boardRanks:z.record(identifier,z.number().int().nonnegative()).optional(),
}).refine(row=>!row.outfitAssumption||row.outfitAssumption.outfitId===row.outfitId,
  {path:['outfitAssumption','outfitId'],message:'The assumption must match the saved outfit.'});

export function readSavedLineups(value:unknown) {
  return z.array(savedLineupSchema).parse(value??[]);
}

type ImportedBoard={characterId:string;releasedSkillTreeNodeGroupIds:string[];
  connectedSkillTreeNodeGroupIds:string[];connectedSkillTreeNodeCardIds:string[]};
export function optimizerBoards(rows:ImportedBoard[]=[]) {
  return Object.fromEntries(rows.map(board=>[
    board.characterId,{nodes:board.releasedSkillTreeNodeGroupIds,
      cards:Object.fromEntries(board.connectedSkillTreeNodeGroupIds.map((slot,index)=>[slot,board.connectedSkillTreeNodeCardIds[index]]))},
  ]));
}
