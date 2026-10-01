/**
 * 对账留痕：现场这份并入中心台账时，每一条现场登记都生成一条留痕。
 * 「两边都改过」的仪器两版都留下（现场版 + 中心版 + 合并版），让人逐条认。
 */
import type { InstrumentType, InstrumentState } from '@/types/instrument';
import type { FieldMergeStatus } from '@/types/fieldInstrument';

/** 留痕种类：新增 / 两边合并 / 撞号挂起 */
export type MergeRecordKind = 'added' | 'merged' | 'suspended';

/** 合并侧重：现场侧重（现场字段按布设班写）/ 中心侧重（争议字段按中心台账写） */
export type MergeStrategy = 'field' | 'center';

/** 现场版快照（现场登记的部署字段） */
export interface FieldSnapshot {
  tempId: string;
  ledgerId: string | null;
  stationCode: string;
  type: InstrumentType;
  model: string;
  serialNo: string;
  installDate: string;
  remark: string;
}

/** 中心版快照（合并前的中心仪器，含在用状态） */
export interface CenterSnapshot {
  id: string;
  stationId: string;
  type: InstrumentType;
  model: string;
  serialNo: string;
  installDate: string;
  state: InstrumentState;
  remark: string;
}

/** 合并版快照（最终写进中心台账的仪器） */
export type MergedSnapshot = CenterSnapshot;

/** 对账留痕 */
export interface MergeRecord {
  id: string;
  /** 对应现场登记临时主键 */
  fieldTempId: string;
  /** 现场登记主键 */
  fieldId: string;
  /** 合并进的中心仪器 id（挂起时为空） */
  instrumentId: string | null;
  /** 序列号（撞号核对用） */
  serialNo: string;
  kind: MergeRecordKind;
  /** 现场版快照 */
  fieldSnapshot: FieldSnapshot;
  /** 中心版快照（新增 / 挂起时为空） */
  centerSnapshot: CenterSnapshot | null;
  /** 合并版快照（挂起时为空） */
  mergedSnapshot: MergedSnapshot | null;
  /** 本次合并实际采用的侧重 */
  strategy: MergeStrategy;
  /** 是否发生过「并入失败 → 保住上一版 → 按侧重试」 */
  retried: boolean;
  /** 失败原因（重试成功时也保留，便于逐条认） */
  failureReason: string | null;
  /** 挂起原因（撞号等） */
  suspendReason: string | null;
  /** 处理结果状态（回写现场登记） */
  resultStatus: FieldMergeStatus;
  /** 是否已逐条核对 */
  reviewed: boolean;
  createdAt: number;
  updatedAt: number;
}
