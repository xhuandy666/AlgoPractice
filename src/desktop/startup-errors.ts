export interface StartupFailure { kind: 'version' | 'migration' | 'disk-full' | 'permission' | 'corrupt' | 'settings' | 'unknown'; title: string; message: string; }
/** Keep recovery instructions local and avoid putting raw exception payloads into logs or dialogs. */
export function startupFailure(error: unknown, dataDirectory: string): StartupFailure {
  const parts: string[] = []; let current = error;
  for (let depth = 0; current && depth < 5; depth++) {
    if (current instanceof Error) { parts.push(current.message, String((current as NodeJS.ErrnoException).code ?? '')); current = current.cause; }
    else { parts.push(String(current)); break; }
  }
  const text = parts.join('\n'); let kind: StartupFailure['kind'] = 'unknown'; let title = '题炼 暂时无法启动'; let action = '保留此数据目录。可重新启动；若仍失败，先复制整个目录，再用匹配版本的应用和已验证备份恢复。';
  if (/Unsupported schema version/i.test(text)) { kind = 'version'; title = '当前版本无法读取这份数据'; action = '数据由不同版本的应用创建。请使用相同或更新的 题炼；如需回退旧版，先保留整个当前目录，再使用升级前的完整备份。不要删除数据库或让旧版强行打开。'; }
  else if (/migration failed/i.test(text)) { kind = 'migration'; title = '数据升级未完成'; action = '请保留整个数据目录及其中的迁移前备份。升级失败的数据库不会作为新库继续使用。排除磁盘空间或权限问题后重试；若需回退，先复制当前目录，再使用原版本与升级前备份。'; }
  else if (/ENOSPC|SQLITE_FULL|database or disk is full/i.test(text)) { kind = 'disk-full'; title = '磁盘空间不足'; action = '请释放此磁盘的空间后重新打开。已保存数据需要保留，不要删除数据库、附件或备份来修复启动。'; }
  else if (/EACCES|EPERM|SQLITE_READONLY|readonly|read-only|permission denied/i.test(text)) { kind = 'permission'; title = '数据目录不可写'; action = '请确认当前用户对数据目录有读写权限，且目录所在磁盘可写。不要通过覆盖数据库解决权限问题；修复权限后重新打开。'; }
  else if (/SQLITE_CORRUPT|SQLITE_NOTADB|malformed|file is not a database/i.test(text)) { kind = 'corrupt'; title = '数据文件未通过完整性检查'; action = '请先复制整个数据目录。使用已验证的完整备份恢复到独立目录，保留当前文件用于排查；不要静默重建或覆盖现有数据库。'; }
  else if (/设置文件|Unexpected.*JSON|JSON.*position|JSON.*end/i.test(text)) { kind = 'settings'; title = '本机设置未能读取'; action = '请保留数据目录中的设置文件及完整备份。检查最近的手动编辑或恢复操作，修复设置后重试；数据库不会因为设置错误而重建。'; }
  return { kind, title, message: `${action}\n\n数据目录：${dataDirectory}` };
}
