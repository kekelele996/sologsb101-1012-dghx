/**
 * 现场台账 → 中心台账的对账计划（纯函数，不触碰 IndexedDB，便于单测与重试复用）。
 *
 * 规则：
 * 1. 现场拥有字段（类型/型号/序列号/安装日期/所属台站）按现场版写；
 * 2. 中心拥有字段（在用状态、历次标定、响应结论）按中心版留，现场标定一律不并入；
 * 3. 同一台仪器两边都改过：按规则并入后生成「待认」条目，两版快照都留存；
 * 4. 现场序列号撞在册仪器（或现场批内重号）：整台挂起，不进 instruments；
 * 5. 现场仪器引用的台站/台阵缺失时，作为引用数据补挂到中心（台账骨架不属标定室专有）。
 */
import type { Calibration } from '@/types/calibration';
import type { Instrument } from '@/types/instrument';
import type { SeisArray } from '@/types/array';
import type { SeisStation } from '@/types/station';
import {
  FIELD_OWNED_KEYS,
  FIELD_OWNED_LABELS,
  createEmptyMergeStats,
  type MergeFieldDiff,
  type MergeStats,
  type PendingMergeReviewItem,
  type PendingMergeSuspended,
} from '@/types/merge';
import type { MergeSnapshot } from '@/types/merge';

export interface BuildPlanInput {
  center: MergeSnapshot;
  field: MergeSnapshot;
  /** 台站 id → 台站码（中心 + 现场合并后的全集），所属台站字段展示用 */
  stationCodes?: Map<string, string>;
}

export interface MergePlan {
  /** 最终要 bulkPut 的仪器行（现场字段 + 中心字段拼合，未含挂起仪器） */
  mergedInstruments: Instrument[];
  /** 需要补挂的台阵（现场引用、中心没有） */
  arraysToAttach: SeisArray[];
  /** 需要补挂的台站（现场引用、中心没有） */
  stationsToAttach: SeisStation[];
  /** 两边都改过，并入后待逐条认 */
  reviewItems: PendingMergeReviewItem[];
  /** 撞号等原因挂起的现场仪器 */
  suspended: PendingMergeSuspended[];
  stats: MergeStats;
}

/** 规范化序列号：去空白，便于撞号比对 */
export function normalizeSerialNo(value: string): string {
  return (value ?? '').trim();
}

/** 深拷贝快照，防止计划阶段的改动污染调用方持有的数据 */
function cloneSnapshot(snapshot: MergeSnapshot): MergeSnapshot {
  return {
    arrays: snapshot.arrays.map((row) => ({ ...row })),
    stations: snapshot.stations.map((row) => ({ ...row })),
    instruments: snapshot.instruments.map((row) => ({ ...row })),
    calibrations: snapshot.calibrations.map((row) => ({ ...row })),
    replaces: snapshot.replaces.map((row) => ({ ...row })),
  };
}

function formatValue(key: string, value: unknown, stationCodes: Map<string, string>): string {
  if (key === 'stationId') {
    const id = String(value ?? '');
    return stationCodes.get(id) ? `${stationCodes.get(id)}（${id}）` : id || '—';
  }
  if (value === undefined || value === null || value === '') return '—';
  return String(value);
}

/** 生成字段级两版对照（只列出有差异的字段；标定差异固定附一条 center 归属的对照） */
export function buildFieldDiffs(
  fieldInstrument: Instrument,
  centerInstrument: Instrument,
  fieldCalibrationCount: number,
  centerCalibrationCount: number,
  stationCodes: Map<string, string>
): MergeFieldDiff[] {
  const diffs: MergeFieldDiff[] = [];
  FIELD_OWNED_KEYS.forEach((key) => {
    const fieldValue = fieldInstrument[key];
    const centerValue = centerInstrument[key];
    if (normalizeSerialNo(key === 'serialNo' ? String(fieldValue) : String(fieldValue)) !==
        normalizeSerialNo(key === 'serialNo' ? String(centerValue) : String(centerValue))) {
      diffs.push({
        key,
        label: FIELD_OWNED_LABELS[key],
        fieldValue: formatValue(key, fieldValue, stationCodes),
        centerValue: formatValue(key, centerValue, stationCodes),
        owner: 'field',
      });
    }
  });
  // 历次标定 / 响应结论是中心专属：即使现场带了标定也不并入，留一条对照让人知道两边数量
  diffs.push({
    key: 'calibrations',
    label: '历次标定 / 响应结论',
    fieldValue: `现场版 ${fieldCalibrationCount} 条（不并入）`,
    centerValue: `中心版 ${centerCalibrationCount} 条（已保留）`,
    owner: 'center',
  });
  return diffs;
}

/**
 * 构建合并计划（只读输入，不产生任何副作用）。
 */
export function buildMergePlan(input: BuildPlanInput): MergePlan {
  const center = cloneSnapshot(input.center);
  const field = cloneSnapshot(input.field);
  const stats = createEmptyMergeStats();

  // 台站码全集（现场 + 中心），补挂的台站也纳入
  const stationCodes = new Map<string, string>();
  [...center.stations, ...field.stations].forEach((station) => {
    stationCodes.set(station.id, station.code);
  });
  input.stationCodes?.forEach((code, id) => stationCodes.set(id, code));

  // 1) 引用骨架补齐：现场仪器引用的台阵 / 台站在中心不存在时补挂
  const centerArrayIds = new Set(center.arrays.map((row) => row.id));
  const centerStationIds = new Set(center.stations.map((row) => row.id));
  const referencedStationIds = new Set(field.instruments.map((row) => row.stationId).filter(Boolean));
  const arraysToAttach = field.arrays.filter((row) => !centerArrayIds.has(row.id));
  const stationsToAttach = field.stations.filter(
    (row) => !centerStationIds.has(row.id) && referencedStationIds.has(row.id)
  );
  stats.arrayCount = arraysToAttach.length;
  stats.stationCount = stationsToAttach.length;

  // 2) 序列号撞号预判：在册序列号 → 仪器
  const centerSerialIndex = new Map<string, Instrument>();
  center.instruments.forEach((instrument) => {
    centerSerialIndex.set(normalizeSerialNo(instrument.serialNo).toLowerCase(), instrument);
  });

  // 现场批内序列号重复检测（同序列号出现多次即重复）
  const fieldSerialSeen = new Map<string, Instrument>();
  const duplicatedSerials = new Set<string>();
  field.instruments.forEach((instrument) => {
    const key = normalizeSerialNo(instrument.serialNo).toLowerCase();
    if (fieldSerialSeen.has(key)) duplicatedSerials.add(key);
    else fieldSerialSeen.set(key, instrument);
  });

  const centerById = new Map(center.instruments.map((row) => [row.id, row]));
  const fieldCalCount = new Map<string, number>();
  field.calibrations.forEach((row) => {
    fieldCalCount.set(row.instrumentId, (fieldCalCount.get(row.instrumentId) ?? 0) + 1);
  });
  const centerCalCount = new Map<string, number>();
  center.calibrations.forEach((row) => {
    centerCalCount.set(row.instrumentId, (centerCalCount.get(row.instrumentId) ?? 0) + 1);
  });

  stats.skippedCalibrationCount = field.calibrations.length;

  const mergedInstruments: Instrument[] = [];
  const reviewItems: PendingMergeReviewItem[] = [];
  const suspended: PendingMergeSuspended[] = [];

  field.instruments.forEach((fieldInstrument) => {
    const serialKey = normalizeSerialNo(fieldInstrument.serialNo).toLowerCase();
    const serialHolder = centerSerialIndex.get(serialKey);
    const centerSameId = centerById.get(fieldInstrument.id);

    // 3) 撞号：序列号被在册的另一台仪器占用（id 不同）→ 挂起
    if (serialHolder && serialHolder.id !== fieldInstrument.id) {
      suspended.push({
        instrumentId: fieldInstrument.id,
        serialNo: fieldInstrument.serialNo,
        model: fieldInstrument.model,
        type: fieldInstrument.type,
        installDate: fieldInstrument.installDate,
        stationId: fieldInstrument.stationId,
        reason: 'serial-collision',
        detail: `现场序列号「${fieldInstrument.serialNo}」已被在册仪器 ${serialHolder.model}（${serialHolder.id}）占用`,
        conflictInstrumentId: serialHolder.id,
        conflictSerialNo: serialHolder.serialNo,
        fieldInstrument,
      });
      return;
    }

    // 4) 现场批内重号 → 挂起（同名记录无法判断归属）
    if (duplicatedSerials.has(serialKey)) {
      suspended.push({
        instrumentId: fieldInstrument.id,
        serialNo: fieldInstrument.serialNo,
        model: fieldInstrument.model,
        type: fieldInstrument.type,
        installDate: fieldInstrument.installDate,
        stationId: fieldInstrument.stationId,
        reason: 'duplicate-in-field',
        detail: `序列号「${fieldInstrument.serialNo}」在本次现场台账中出现多次`,
        fieldInstrument,
      });
      return;
    }

    if (!centerSameId) {
      // 5) 新仪器：现场字段全收，state 取现场自报（中心无旧版可保留），进表
      mergedInstruments.push({ ...fieldInstrument });
      stats.newCount += 1;
      return;
    }

    // 6) 两边都改过：现场拥有字段按现场写，中心拥有字段（state）按中心留
    const now = Date.now();
    const merged: Instrument = {
      ...centerSameId,
      // 现场拥有字段逐个覆盖
      ...FIELD_OWNED_KEYS.reduce<Partial<Instrument>>((patch, key) => {
        patch[key] = fieldInstrument[key] as never;
        return patch;
      }, {}),
      // 中心拥有字段（state / remark）显式保留中心版，历次标定在独立表中原样留存
      state: centerSameId.state,
      remark: centerSameId.remark,
      createdAt: centerSameId.createdAt,
      updatedAt: now,
    };
    mergedInstruments.push(merged);
    stats.modifiedCount += 1;

    const fCount = fieldCalCount.get(fieldInstrument.id) ?? 0;
    const cCount = centerCalCount.get(centerSameId.id) ?? 0;
    const diffs = buildFieldDiffs(fieldInstrument, centerSameId, fCount, cCount, stationCodes);
    // 只要现场版与中心版有任何差异（含标定数量对照），就留待认条目
    reviewItems.push({
      instrumentId: fieldInstrument.id,
      serialNo: merged.serialNo,
      model: merged.model,
      kind: 'both-modified',
      diffs,
      fieldInstrument,
      centerInstrument: centerSameId,
      fieldCalibrationCount: fCount,
      centerCalibrationCount: cCount,
    });
  });

  stats.reviewCount = reviewItems.length;
  stats.suspendedCount = suspended.length;

  return {
    mergedInstruments,
    arraysToAttach,
    stationsToAttach,
    reviewItems,
    suspended,
    stats,
  };
}

/** 校验现场快照的基本形状（与备份文件类似但语义独立） */
export function validateFieldSnapshot(input: unknown): {
  ok: boolean;
  errors: string[];
  snapshot: MergeSnapshot | null;
} {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, errors: ['文件内容不是合法的 JSON 对象'], snapshot: null };
  }
  const obj = input as Partial<MergeSnapshot>;
  const errors: string[] = [];
  (['arrays', 'stations', 'instruments', 'calibrations', 'replaces'] as const).forEach((key) => {
    if (!Array.isArray(obj[key])) errors.push(`${key} 字段缺失或不是数组`);
  });
  if (errors.length > 0) return { ok: false, errors, snapshot: null };
  const snapshot: MergeSnapshot = {
    arrays: obj.arrays ?? [],
    stations: obj.stations ?? [],
    instruments: obj.instruments ?? [],
    calibrations: (obj.calibrations ?? []) as Calibration[],
    replaces: obj.replaces ?? [],
  };
  return { ok: true, errors: [], snapshot };
}
