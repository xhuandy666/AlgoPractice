import {test} from 'node:test';
import assert from 'node:assert/strict';
import {startupFailure} from '../../src/desktop/startup-errors';

test('a database of another version explains the clean break without exposing raw error data',()=>{
 const result=startupFailure(new Error('Unsupported schema version: 999\nSECRET_FROM_UNTRUSTED_ERROR'),'/tmp/中文 数据');
 assert.equal(result.kind,'version');assert.match(result.message,/v0\.91\.0 及更早版本的数据，当前版本不再读取/);assert.match(result.message,/更新版本的数据，请使用相同或更新的题炼/);assert.match(result.message,/请勿删除数据库/);assert.match(result.message,/中文 数据/);assert.ok(!result.message.includes('SECRET'));
});
test('startup classifies disk full, readonly, corruption and settings failures with actionable local recovery',()=>{
 for(const [message,kind] of [['SQLITE_FULL: database or disk is full','disk-full'],['EACCES permission denied','permission'],['attempt to write a readonly database','permission'],['设置文件不可读取','settings']] as const){const result=startupFailure(new Error(message),'/tmp/data');assert.equal(result.kind,kind);assert.match(result.message,/数据目录：\/tmp\/data/);assert.match(result.message,/保留|复制|请勿/);}
});
test('only SQLite\'s own damage verdicts classify as corrupt, never similar wording from elsewhere',()=>{
 const sqlite=(message:string,errcode:number)=>Object.assign(new Error(message),{code:'ERR_SQLITE_ERROR',errcode,errstr:message});
 assert.equal(startupFailure(sqlite('file is not a database',26),'/tmp/data').kind,'corrupt');
 assert.equal(startupFailure(sqlite('database disk image is malformed',11),'/tmp/data').kind,'corrupt');
 assert.equal(startupFailure(sqlite('database disk image is malformed',11|(1<<8)),'/tmp/data').kind,'corrupt','extended SQLITE_CORRUPT_* codes');
 assert.equal(startupFailure(Object.assign(new Error('SQLite integrity check failed'),{code:'ALGOPRACTICE_SQLITE_INTEGRITY'}),'/tmp/data').kind,'corrupt');
 assert.equal(startupFailure(new Error('wrapper',{cause:sqlite('file is not a database',26)}),'/tmp/data').kind,'corrupt','found along the cause chain');
 for(const error of [new Error('file is not a database'),new Error('database disk image is malformed'),new URIError('URI malformed'),new Error('SQLite foreign key check failed')])assert.notEqual(startupFailure(error,'/tmp/data').kind,'corrupt',error.message);
});
test('damage behind a version mismatch, a full disk, missing permissions, I/O or lock errors never classifies as corrupt',()=>{
 const sqlite=(message:string,errcode:number)=>Object.assign(new Error(message),{code:'ERR_SQLITE_ERROR',errcode,errstr:message});
 const corrupt=sqlite('database disk image is malformed',11);
 assert.equal(startupFailure(new Error('Unsupported schema version: 99',{cause:corrupt}),'/tmp/data').kind,'version');
 assert.equal(startupFailure(sqlite('database or disk is full',13),'/tmp/data').kind,'disk-full');
 assert.equal(startupFailure(sqlite('attempt to write a readonly database',8),'/tmp/data').kind,'permission');
 for(const code of [10,10|(13<<8),5,6,14])assert.equal(startupFailure(new AggregateError([corrupt,sqlite('other',code)],'x'),'/tmp/data').kind,'unknown',`code ${code}`);
});
