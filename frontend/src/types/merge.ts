/**
 * 现场离线台账 → 中心台账合并对账相关类型。
 *
 * 职责边界（两班各持各的数据）：
 * - 现场布设班拥有：仪器类型、型号、序列号、安装日期、所属台站；合并时以现场版为准。
 * - 中心标定室拥有：在用状态、历次标定记录、响应结论；合并时始终保留中心版，现场标定不并入。
 * - 两边都改过的仪器：两版都留存，生成「待认」条目交由人逐条认。
 * - 现场序列号与在册仪器撞号：整台挂起，不进 instruments 表。
 */
import type { Instrument, InstrumentType } from './instrument';

/** 数据归属方 */
export type MergeSide = 'field' | 'center';

/** 现场拥有、合并时以现场为准的仪器字段 */
export const FIELD_OWNED_KEYS = ['type', 'model', 'serialNo', 'installDate', 'stationId'] as const;
export type FieldOwnedKey = (typeof FIELD_OWNED_KEYS)[number];

/** 中心拥有、始终保留中心版的字段（在用状态；历次标定是独立的表，不随仪器覆盖） */
export const CENTER_OWNED_KEYS = ['state'] as const;

export const FIELD_OWNED_LABELS: Record<FieldOwnedKey, string> = {
  type: '类型',
  model: '型号',
  serialNo: '序列号',
  installDate: '安装日期',
  stationId: '所属台站',
};

/** 挂起原因 */
export type MergeSuspendReason = 'serial-collision' | 'duplicate-in-field';

export const MERGE_SUSPEND_REASON_TEXT: Record<MergeSuspendReason, string> = {
  'serial-collision': '序列号撞在册仪器',
  'duplicate-in-field': '现场台账内序列号重复',
};

/** 一条字段级的两版对照（供逐条认） */
export interface MergeFieldDiff {
  /** 字段名；历次标定信息用固定键 'calibrations' */
  key: FieldOwnedKey | 'calibrations';
  /** 字段中文名 */
  label: string;
  /** 现场版（已格式化为文本） */
  fieldValue: string;
  /** 中心版（已格式化为文本） */
  centerValue: string;
  /** 字段归属：field 默认采纳现场，center 始终保留中心 */
  owner: MergeSide;
}

/** 待逐条确认条目的持久化状态 */
export type MergeReviewStatus = '待认' | '已认';

/** 人工裁决：维持已并入的现场版，或改回中心版 */
export type MergeReviewDecision = '维持现场版' | '改用中心版';

/** 建计划时尚未落库的对账条目 */
export interface PendingMergeReviewItem {
  /** 仪器 id（两边按同一 id 对上） */
  instrumentId: string;
  /** 冗余字段，列表展示用 */
  serialNo: string;
  model: string;
  kind: 'both-modified';
  /** 字段级两版对照 */
  diffs: MergeFieldDiff[];
  /** 现场版仪器全量快照（改判时可回写） */
  fieldInstrument: Instrument;
  /** 中心版仪器全量快照（改判时可回写） */
  centerInstrument: Instrument;
  /** 现场台账中该仪器的标定条数（仅作对照，不并入） */
  fieldCalibrationCount: number;
  /** 中心台账中该仪器的标定条数（始终保留） */
  centerCalibrationCount: number;
}

/** 已落库的对账条目 */
export interface MergeReviewItem extends PendingMergeReviewItem {
  id: string;
  batchId: string;
  status: MergeReviewStatus;
  decision?: MergeReviewDecision;
  /** 逐条认时每个现场拥有字段最终采纳的一方（缺省为 field，与并入时一致） */
  fieldChoices?: Partial<Record<FieldOwnedKey, MergeSide>>;
  /** 裁决备注 */
  note: string;
  createdAt: number;
  updatedAt: number;
  resolvedAt?: number;
}

/** 建计划时尚未落库的挂起仪器 */
export interface PendingMergeSuspended {
  instrumentId: string;
  serialNo: string;
  model: string;
  type: InstrumentType;
  installDate: string;
  stationId: string;
  reason: MergeSuspendReason;
  /** 撞号说明（含被撞的在册仪器） */
  detail: string;
  conflictInstrumentId?: string;
  conflictSerialNo?: string;
  /** 现场版全量快照，解除撞号后可重新报入 */
  fieldInstrument: Instrument;
}

/** 已落库的挂起仪器 */
export interface MergeSuspended extends PendingMergeSuspended {
  id: string;
  batchId: string;
  status: '挂起中' | '已认领';
  createdAt: number;
  acknowledgedAt?: number;
}

/** 并入统计 */
export interface MergeStats {
  /** 现场带来的新台阵数（补挂引用） */
  arrayCount: number;
  /** 现场带来的新台站数 */
  stationCount: number;
  /** 新增仪器数 */
  newCount: number;
  /** 两边都改过的仪器数 */
  modifiedCount: number;
  /** 生成的待认条目数 */
  reviewCount: number;
  /** 撞号挂起数 */
  suspendedCount: number;
  /** 现场标定记录条数（一律不并入，标定归中心） */
  skippedCalibrationCount: number;
}

/** 一次并入批次的状态 */
export type MergeBatchStatus = '已并入' | '并入失败' | '已回滚';

/** 一次现场合并批次 */
export interface MergeBatch {
  id: string;
  /** 现场文件名等来源说明 */
  sourceName: string;
  /** 现场快照的导出时间 */
  sourceExportedAt: string | null;
  mergedAt: number;
  status: MergeBatchStatus;
  stats: MergeStats;
  /** 并入前的中心快照 id */
  backupId: string;
  /** 失败原因或备注 */
  note: string;
}

/** 并入前留存的中心五表快照（MergeBackup.snapshot 的结构） */
export interface MergeSnapshot {
  arrays: import('./array').SeisArray[];
  stations: import('./station').SeisStation[];
  instruments: Instrument[];
  calibrations: import('./calibration').Calibration[];
  replaces: import('./replace').Replace[];
}

/** 中心台账上一版快照（并入失败重试与整批回滚用） */
export interface MergeBackup {
  id: string;
  batchId: string;
  createdAt: number;
  snapshot: MergeSnapshot;
}

export function createEmptyMergeStats(): MergeStats {
  return {
    arrayCount: 0,
    stationCount: 0,
    newCount: 0,
    modifiedCount: 0,
    reviewCount: 0,
    suspendedCount: 0,
    skippedCalibrationCount: 0,
  };
}
