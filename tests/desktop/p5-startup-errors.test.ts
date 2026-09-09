import {test} from 'node:test';
import assert from 'node:assert/strict';
import {startupFailure} from '../../src/desktop/startup-errors';

test('newer database gives preservation and downgrade recovery guidance without exposing raw error data',()=>{
 const result=startupFailure(new Error('Unsupported schema version: 999\nSECRET_FROM_UNTRUSTED_ERROR'),'/tmp/中文 数据');
 assert.equal(result.kind,'version');assert.match(result.message,/升级前.*备份/);assert.match(result.message,/不要删除数据库/);assert.match(result.message,/中文 数据/);assert.ok(!result.message.includes('SECRET'));
});
test('migration failure stays a migration problem even when its cause is a disk error',()=>{
 const error=new Error('Schema v5 migration failed; original schema retained.',{cause:Object.assign(new Error('disk full'),{code:'ENOSPC'})});
 assert.equal(startupFailure(error,'/tmp/data').kind,'migration');assert.match(startupFailure(error,'/tmp/data').message,/迁移前备份/);
});
test('startup classifies disk full, readonly, corruption and settings failures with actionable local recovery',()=>{
 for(const [message,kind] of [['SQLITE_FULL: database or disk is full','disk-full'],['EACCES permission denied','permission'],['attempt to write a readonly database','permission'],['file is not a database','corrupt'],['设置文件不可读取','settings']] as const){const result=startupFailure(new Error(message),'/tmp/data');assert.equal(result.kind,kind);assert.match(result.message,/数据目录：\/tmp\/data/);assert.match(result.message,/保留|复制|不要/);}
});
