/**
 * 现场对账合并引擎。
 *
 * 背景：野外布设班在平板上离线登记新仪器（型号 / 序列号 / 安装日期 / 所属台站），
 * 台网中心标定室另有正式台账（历次标定 / 响应结论 / 在用状态）。网络恢复后把现场
 * 这份合并进中心台账对账：
 *
 * 1. 一台仪器两边都改过时，现场字段（型号 / 序列号 / 安装日期 / 所属台站）按布设班
 *    那份写，历次标定与响应结论按标定室那份写，两版都留着让人逐条认；
 * 2. 现场报的序列号若和在册仪器撞号，这台先挂起不进台账；
 * 3. 并入失败后按侧重试一遍，中心那份上一版先保住。
 */
import { db, createId } from '@/utils/db';
import type { Calibration } from '@/types/calibration';
import type { Instrument, InstrumentState } from '@/types/instrument';
import type { FieldInstrument } from '@/types/fieldInstrument';
import type {
  MergeRecord,
  MergeStrategy,
  FieldSnapshot,
  CenterSnapshot,
} from '@/types/mergeRecord';

/** 合并失败：现场侧重撞上硬约束（如序列号唯一性），需保住上一版后按中心侧重试 */
export class MergeStrategyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MergeStrategyError';
  }
}

/** 中心台账快照（合并前的上一版） */
export interface CenterSnapshotBundle {
  instruments: Instrument[];
  calibrations: Calibration[];
}

/** 单条现场登记的合并结果 */
export interface FieldMergeOutcome {
  fieldId: string;
  kind: MergeRecord['kind'];
  instrumentId: string | null;
  record: MergeRecord;
}

/** 整批合并结果 */
export interface MergeResult {
  outcomes: FieldMergeOutcome[];
  added: number;
  merged: number;
  suspended: number;
  /** 实际采用的侧重 */
  strategy: MergeStrategy;
  /** 是否发生过「并入失败 → 保住上一版 → 按侧重试」 */
  retried: boolean;
  /** 重试前的失败原因（重试成功也保留，便于逐条认） */
  failureReason: string | null;
}

/* ------------------------------ 快照与回滚 ------------------------------ */

/** 保住中心台账上一版：合并前备份仪器与标定 */
export async function snapshotCenter(): Promise<CenterSnapshotBundle> {
  const [instruments, calibrations] = await Promise.all([
    db.instruments.toArray(),
    db.calibrations.toArray(),
  ]);
  return { instruments, calibrations };
}

/** 恢复中心台账到上一版（并入失败后回滚） */
export async function restoreCenter(snapshot: CenterSnapshotBundle): Promise<void> {
  await db.transaction('rw', [db.instruments, db.calibrations], async () => {
    await db.instruments.clear();
    await db.calibrations.clear();
    await db.instruments.bulkPut(snapshot.instruments);
    await db.calibrations.bulkPut(snapshot.calibrations);
  });
}

/* ------------------------------ 快照构造 ------------------------------ */

function toFieldSnapshot(field: FieldInstrument): FieldSnapshot {
  return {
    tempId: field.tempId,
    ledgerId: field.ledgerId,
    stationCode: field.stationCode,
    type: field.type,
    model: field.model,
    serialNo: field.serialNo,
    installDate: field.installDate,
    remark: field.remark,
  };
}

function toCenterSnapshot(instrument: Instrument): CenterSnapshot {
  return {
    id: instrument.id,
    stationId: instrument.stationId,
    type: instrument.type,
    model: instrument.model,
    serialNo: instrument.serialNo,
    installDate: instrument.installDate,
    state: instrument.state,
    remark: instrument.remark,
  };
}

/* ------------------------------ 核心合并 ------------------------------ */

/**
 * 把现场登记合并进中心台账。
 * - strategy='field'（现场侧重）：现场字段按布设班那份写；撞上序列号唯一性则抛 MergeStrategyError。
 * - strategy='center'（中心侧重）：争议字段按中心台账写，现场版仍留痕。
 *
 * 历次标定与响应结论始终以中心台账为准（现场表不携带这些字段，合并时不动标定表）。
 */
export async function mergeFieldInstruments(
  fieldRows: FieldInstrument[],
  strategy: MergeStrategy
): Promise<MergeResult> {
  const now = Date.now();
  const outcomes: FieldMergeOutcome[] = [];

  // 读与写在同一事务内，避免跨标签页读到中间状态
  await db.transaction(
    'rw',
    [db.instruments, db.stations, db.fieldInstruments, db.mergeRecords],
    async () => {
      const [centerInstruments, stations] = await Promise.all([
        db.instruments.toArray(),
        db.stations.toArray(),
      ]);

      const centerById = new Map(centerInstruments.map((ins) => [ins.id, ins]));
      const centerBySerial = new Map(centerInstruments.map((ins) => [ins.serialNo, ins]));
      const stationIdByCode = new Map(stations.map((stn) => [stn.code, stn.id]));
      const fallbackStationId = stations[0]?.id ?? '';

      for (const field of fieldRows) {
        const fieldSnapshot = toFieldSnapshot(field);
        const sameInstrument = field.ledgerId ? centerById.get(field.ledgerId) : undefined;

        if (sameInstrument) {
          // 两边都改过：现场字段按侧重写，在用状态 / 标定结论按中心台账
          const collision =
            field.serialNo !== sameInstrument.serialNo &&
            centerBySerial.has(field.serialNo) &&
            centerBySerial.get(field.serialNo)?.id !== sameInstrument.id;

          if (strategy === 'field' && collision) {
            throw new MergeStrategyError(
              `现场侧重合并失败：仪器 ${sameInstrument.model}（${sameInstrument.serialNo}）` +
                `现场改报序列号「${field.serialNo}」与在册仪器撞号，违反序列号唯一性`
            );
          }

          const stationId =
            stationIdByCode.get(field.stationCode) ?? sameInstrument.stationId;
          const merged: Instrument = {
            ...sameInstrument,
            // 现场字段：现场侧重用现场值，中心侧重保留中心值
            type: strategy === 'field' ? field.type : sameInstrument.type,
            model: strategy === 'field' ? field.model : sameInstrument.model,
            serialNo: strategy === 'field' ? field.serialNo : sameInstrument.serialNo,
            installDate: strategy === 'field' ? field.installDate : sameInstrument.installDate,
            stationId,
            // 在用状态 / 标定结论始终按中心台账
            state: sameInstrument.state,
            remark: sameInstrument.remark,
            updatedAt: now,
          };

          await db.instruments.put(merged);

          const record: MergeRecord = {
            id: createId('mrg'),
            fieldTempId: field.tempId,
            fieldId: field.id,
            instrumentId: merged.id,
            serialNo: merged.serialNo,
            kind: 'merged',
            fieldSnapshot,
            centerSnapshot: toCenterSnapshot(sameInstrument),
            mergedSnapshot: toCenterSnapshot(merged),
            strategy,
            retried: false,
            failureReason: null,
            suspendReason: null,
            resultStatus: 'merged',
            reviewed: false,
            createdAt: now,
            updatedAt: now,
          };
          await db.mergeRecords.put(record);
          outcomes.push({ fieldId: field.id, kind: 'merged', instrumentId: merged.id, record });
        } else if (centerBySerial.has(field.serialNo)) {
          // 撞号：这台先挂起不进台账
          const hit = centerBySerial.get(field.serialNo)!;
          const record: MergeRecord = {
            id: createId('mrg'),
            fieldTempId: field.tempId,
            fieldId: field.id,
            instrumentId: null,
            serialNo: field.serialNo,
            kind: 'suspended',
            fieldSnapshot,
            centerSnapshot: toCenterSnapshot(hit),
            mergedSnapshot: null,
            strategy,
            retried: false,
            failureReason: null,
            suspendReason: `现场报序列号「${field.serialNo}」与在册仪器 ${hit.model}（台站 ${hit.stationId}）撞号，先挂起不进台账`,
            resultStatus: 'suspended',
            reviewed: false,
            createdAt: now,
            updatedAt: now,
          };
          await db.mergeRecords.put(record);
          outcomes.push({ fieldId: field.id, kind: 'suspended', instrumentId: null, record });
        } else {
          // 新增：现场新登记，序列号不撞号
          const stationId = stationIdByCode.get(field.stationCode) ?? fallbackStationId;
          const instrument: Instrument = {
            id: createId('ins'),
            stationId,
            type: field.type,
            model: field.model,
            serialNo: field.serialNo,
            installDate: field.installDate,
            state: '在用' as InstrumentState,
            remark: field.remark,
            createdAt: now,
            updatedAt: now,
          };
          await db.instruments.put(instrument);

          const record: MergeRecord = {
            id: createId('mrg'),
            fieldTempId: field.tempId,
            fieldId: field.id,
            instrumentId: instrument.id,
            serialNo: field.serialNo,
            kind: 'added',
            fieldSnapshot,
            centerSnapshot: null,
            mergedSnapshot: toCenterSnapshot(instrument),
            strategy,
            retried: false,
            failureReason: null,
            suspendReason: null,
            resultStatus: 'added',
            reviewed: false,
            createdAt: now,
            updatedAt: now,
          };
          await db.mergeRecords.put(record);
          outcomes.push({ fieldId: field.id, kind: 'added', instrumentId: instrument.id, record });
        }
    }

    // 回写现场登记处理状态
    for (const outcome of outcomes) {
      await db.fieldInstruments.update(outcome.fieldId, {
        mergeStatus: outcome.record.resultStatus,
        updatedAt: now,
      } as never);
    }
  });

  return {
    outcomes,
    added: outcomes.filter((o) => o.kind === 'added').length,
    merged: outcomes.filter((o) => o.kind === 'merged').length,
    suspended: outcomes.filter((o) => o.kind === 'suspended').length,
    strategy,
    retried: false,
    failureReason: null,
  };
}

/**
 * 对账合并（含失败重试）：
 * 1. 先保住中心台账上一版（快照）；
 * 2. 按现场侧重并入；
 * 3. 若撞上硬约束失败，回滚到上一版，再按中心侧重试一遍。
 */
export async function reconcileWithRetry(
  fieldRows: FieldInstrument[]
): Promise<MergeResult> {
  // 只处理待处理的现场登记
  const pending = fieldRows.filter((row) => row.mergeStatus === 'pending');
  if (pending.length === 0) {
    return {
      outcomes: [],
      added: 0,
      merged: 0,
      suspended: 0,
      strategy: 'field',
      retried: false,
      failureReason: null,
    };
  }

  // 并入前先保住中心台账上一版
  const snapshot = await snapshotCenter();

  try {
    return await mergeFieldInstruments(pending, 'field');
  } catch (error) {
    if (!(error instanceof MergeStrategyError)) throw error;
    // 并入失败：回滚到上一版，再按中心侧重试一遍
    await restoreCenter(snapshot);
    const retried = await mergeFieldInstruments(pending, 'center');
    return {
      ...retried,
      strategy: 'center',
      retried: true,
      failureReason: error.message,
    };
  }
}
