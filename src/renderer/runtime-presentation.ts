import type { RuntimeProgress } from '../shared/bridge';
import type { RuntimeState } from '../shared/runtime';

export const runtimePhaseLabels: Record<RuntimeProgress['phase'], string> = {
  download: '正在下载', copy: '正在读取离线包', verify: '正在校验下载包', extract: '正在解压',
  validate: '正在验证运行能力', commit: '正在安全启用', ready: '环境已就绪',
};
export const runtimeSourceLabels: Record<NonNullable<RuntimeState['source']>, string> = {
  selected: '手动选择的本机环境', managed: '应用托管环境', discovered: '自动发现的本机环境',
};

export function runtimeBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '尚未测量';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length);
  const size = bytes / 1024 ** exponent;
  return `${size.toLocaleString('zh-CN', { maximumFractionDigits: 1 })} ${units[exponent - 1]}`;
}

/** Byte progress applies to transfer only, never to the entire installation. */
export function runtimeTransferPercent(progress: RuntimeProgress | null | undefined): number | undefined {
  if (!progress || !['download', 'copy'].includes(progress.phase) || !Number.isFinite(progress.totalBytes)
    || progress.totalBytes <= 0 || !Number.isFinite(progress.receivedBytes) || progress.receivedBytes < 0) return undefined;
  return Math.min(100, Math.max(0, Math.round(progress.receivedBytes / progress.totalBytes * 100)));
}
