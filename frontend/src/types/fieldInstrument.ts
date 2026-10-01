/**
 * 现场登记表（野外布设班离线登记）。
 * 网络恢复后把这份合并进台网中心台账对账：
 * 现场只登记仪器的「型号 / 序列号 / 安装日期 / 所属台站」，
 * 历次标定、响应结论与在用状态以中心台账为准。
 */
import type { InstrumentType } from '@/types/instrument';

/** 现场登记处理状态 */
export type FieldMergeStatus = 'pending' | 'added' | 'merged' | 'suspended';

export const FIELD_MERGE_STATUSES: FieldMergeStatus[] = ['pending', 'added', 'merged', 'suspended'];

/** 现场仪器登记：平板离线录入，字段与中心 Instrument 对齐但不直接写中心表 */
export interface FieldInstrument {
  id: string;
  /** 平板端临时主键（离线生成，合并后保留在留痕里） */
  tempId: string;
  /**
   * 对应中心仪器 id：
   * - 有值 → 这台仪器两边都持有数据，按「两边都改过」合并；
   * - 无值 → 现场新登记，按序列号是否撞号决定新增或挂起。
   */
  ledgerId: string | null;
  /** 所属台站码（现场只知道台站码，合并时再换成 stationId） */
  stationCode: string;
  /** 仪器类型 */
  type: InstrumentType;
  /** 型号 */
  model: string;
  /** 序列号（现场填报，撞号则挂起） */
  serialNo: string;
  /** 安装日期 */
  installDate: string;
  /** 现场处理状态 */
  mergeStatus: FieldMergeStatus;
  /** 备注 */
  remark: string;
  createdAt: number;
  updatedAt: number;
}

/** 现场登记草稿（表单用） */
export interface FieldInstrumentDraft {
  ledgerId: string | null;
  stationCode: string;
  type: InstrumentType;
  model: string;
  serialNo: string;
  installDate: string;
  remark: string;
}

export function createEmptyFieldInstrumentDraft(): FieldInstrumentDraft {
  return {
    ledgerId: null,
    stationCode: '',
    type: '宽频带',
    model: '',
    serialNo: '',
    installDate: new Date().toISOString().slice(0, 10),
    remark: '',
  };
}
