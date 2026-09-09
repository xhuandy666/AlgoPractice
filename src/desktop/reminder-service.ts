import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_REMINDER_SETTINGS, REMINDER_SETTINGS_FILE, REMINDER_STATE_FILE } from '../shared/maintenance';
import type { ReminderSettings, ReminderStatus, ReviewNotifier } from '../shared/maintenance';

export function validateReminderSettings(value: unknown): ReminderSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('提醒设置格式无效。');
  const v = value as Record<string, unknown>;
  const keys = ['enabled', 'at', 'quietStart', 'quietEnd', 'snoozeMinutes'];
  if (Object.keys(v).some(key => !keys.includes(key)) || typeof v.enabled !== 'boolean'
    || [v.at, v.quietStart, v.quietEnd].some(time => typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))
    || !Number.isInteger(v.snoozeMinutes) || Number(v.snoozeMinutes) < 1 || Number(v.snoozeMinutes) > 240) throw new Error('提醒时间或稍后提醒设置无效。');
  return { enabled: v.enabled, at: v.at as string, quietStart: v.quietStart as string, quietEnd: v.quietEnd as string, snoozeMinutes: v.snoozeMinutes as number };
}
export function localClock(now: Date, timeZone: string): { day: string; minute: number } {
  if (!Number.isFinite(now.getTime())) throw new Error('当前时间无效。');
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const get = (key: string) => parts.find(part => part.type === key)!.value;
  return { day: `${get('year')}-${get('month')}-${get('day')}`, minute: Number(get('hour')) * 60 + Number(get('minute')) };
}
const minuteOf = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
function quietAt(minute: number, settings: ReminderSettings): boolean {
  const start = minuteOf(settings.quietStart), end = minuteOf(settings.quietEnd);
  return start === end ? false : start < end ? minute >= start && minute < end : minute >= start || minute < end;
}
function atomicJson(file: string, value: unknown): void {
  const temporary = `${file}.${randomUUID()}.partial`, descriptor = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(descriptor, JSON.stringify(value, null, 2)); fsyncSync(descriptor); } finally { closeSync(descriptor); }
  renameSync(temporary, file);
}
function readJson(file: string): unknown {
  const info = lstatSync(file); if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) throw new Error('提醒文件类型或大小无效。');
  return JSON.parse(readFileSync(file, 'utf8'));
}
interface Ledger {
  version: 1;
  days: Record<string, { status: 'sent' | 'failed' | 'missed'; at: string }>;
  pending: boolean;
  snooze: { dueAt: string; expiresAt: string; token: string } | null;
  lastDeliveredAt: string | null; lastError: string | null;
}
function readLedger(value: unknown): Ledger {
  const v = value as Ledger;
  if (!v || v.version !== 1 || !v.days || typeof v.days !== 'object' || Array.isArray(v.days)
    || Object.keys(v.days).length > 20000 || typeof v.pending !== 'boolean'
    || (v.lastDeliveredAt !== null && (typeof v.lastDeliveredAt !== 'string' || !Number.isFinite(Date.parse(v.lastDeliveredAt))))
    || (v.lastError !== null && (typeof v.lastError !== 'string' || v.lastError.length > 2000))) throw new Error('提醒投递记录损坏；已暂停提醒以避免重复投递。');
  for (const [day, record] of Object.entries(v.days)) if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !record || !['sent', 'failed', 'missed'].includes(record.status) || !Number.isFinite(Date.parse(record.at))) throw new Error('提醒每日记录无效。');
  if (v.snooze !== null && (!v.snooze || typeof v.snooze.token !== 'string' || !/^[a-f0-9-]{36}$/.test(v.snooze.token) || !Number.isFinite(Date.parse(v.snooze.dueAt)) || !Number.isFinite(Date.parse(v.snooze.expiresAt)))) throw new Error('稍后提醒记录无效。');
  return v;
}
export interface ReminderServiceOptions {
  directory: string; timeZone(): string; dueCount(): number; notifier: ReviewNotifier;
  onNavigateQueue(): void; onChanged?(): void; now?(): Date;
}
export class ReminderService {
  #settings: ReminderSettings; #ledger: Ledger; #active = false;
  #phase: ReminderStatus['phase'] = 'stopped'; #timer?: ReturnType<typeof setInterval>;
  #currentNotification: string | null = null; #tick?: Promise<ReminderStatus>;
  readonly #statePath: string; readonly #settingsPath: string;
  constructor(private readonly options: ReminderServiceOptions) {
    mkdirSync(options.directory, { recursive: true });
    this.#statePath = join(options.directory, REMINDER_STATE_FILE); this.#settingsPath = join(options.directory, REMINDER_SETTINGS_FILE);
    this.#settings = existsSync(this.#settingsPath) ? validateReminderSettings(readJson(this.#settingsPath)) : { ...DEFAULT_REMINDER_SETTINGS };
    this.#ledger = existsSync(this.#statePath) ? readLedger(readJson(this.#statePath)) : { version: 1, days: {}, pending: false, snooze: null, lastDeliveredAt: null, lastError: null };
    this.#clock();
  }
  #now() { return this.options.now?.() ?? new Date(); }
  #clock() { return localClock(this.#now(), this.options.timeZone()); }
  #due() { const count = this.options.dueCount(); if (!Number.isSafeInteger(count) || count < 0) throw new Error('到期复习数量无效。'); return count; }
  #save() { atomicJson(this.#statePath, this.#ledger); }
  #invalidate() { if (this.#currentNotification) this.options.notifier.dismiss?.(this.#currentNotification); this.#currentNotification = null; }
  settings(): ReminderSettings { return { ...this.#settings }; }
  status(): ReminderStatus {
    return { settings: this.settings(), timeZone: this.options.timeZone(), localDay: this.#clock().day, dueCount: this.#due(), phase: this.#phase,
      lastDeliveredAt: this.#ledger.lastDeliveredAt, lastError: this.#ledger.lastError, snoozedUntil: this.#ledger.snooze?.dueAt ?? null };
  }
  async updateSettings(patch: Partial<ReminderSettings>): Promise<ReminderStatus> {
    this.#settings = validateReminderSettings({ ...this.#settings, ...patch });
    atomicJson(this.#settingsPath, this.#settings); this.#invalidate();
    if (!this.#settings.enabled) { this.#ledger.snooze = null; this.#ledger.pending = false; this.#save(); }
    return this.tick('settings');
  }
  async reloadSettings(): Promise<ReminderStatus> {
    this.#settings = existsSync(this.#settingsPath) ? validateReminderSettings(readJson(this.#settingsPath)) : { ...DEFAULT_REMINDER_SETTINGS };
    this.#invalidate(); return this.tick('startup');
  }
  async start(schedule = true): Promise<ReminderStatus> {
    if (this.#active) return this.status(); this.#active = true;
    if (schedule) this.#timer = setInterval(() => { void this.tick().catch(error => { this.#phase = 'failed'; this.#ledger.lastError = String(error).slice(0, 2000); this.options.onChanged?.(); }); }, 30000);
    this.#timer?.unref(); return this.tick('startup');
  }
  stop(): void { this.#active = false; if (this.#timer) clearInterval(this.#timer); this.#timer = undefined; this.#invalidate(); this.#phase = 'stopped'; }
  async snooze(): Promise<ReminderStatus> {
    if (!this.#active || !this.#settings.enabled || !this.#due()) throw new Error('当前没有可以稍后提醒的复习项。');
    const now = this.#now(); this.#invalidate();
    this.#ledger.snooze = { dueAt: new Date(now.getTime() + this.#settings.snoozeMinutes * 60000).toISOString(), expiresAt: new Date(now.getTime() + 24 * 60 * 60000).toISOString(), token: randomUUID() };
    this.#save(); this.#phase = 'snoozed'; this.options.onChanged?.(); return this.status();
  }
  tick(reason: 'timer' | 'startup' | 'resume' | 'settings' = 'timer'): Promise<ReminderStatus> {
    if (this.#tick) return this.#tick;
    this.#tick = this.#evaluate(reason).finally(() => { this.#tick = undefined; }); return this.#tick;
  }
  async #evaluate(reason: string): Promise<ReminderStatus> {
    const now = this.#now(), clock = this.#clock(), count = this.#due();
    if (!this.#active) { this.#phase = 'stopped'; return this.status(); }
    if (!this.#settings.enabled) { this.#phase = 'disabled'; return this.status(); }
    if (!count) {
      this.#invalidate(); if (this.#ledger.snooze || this.#ledger.pending) { this.#ledger.snooze = null; this.#ledger.pending = false; this.#save(); }
      this.#phase = 'idle'; this.options.onChanged?.(); return this.status();
    }
    if (this.#ledger.snooze && Date.parse(this.#ledger.snooze.expiresAt) <= now.getTime()) { this.#ledger.snooze = null; this.#save(); }
    const pastTime = clock.minute >= minuteOf(this.#settings.at), snooze = this.#ledger.snooze;
    const snoozeDue = Boolean(snooze && Date.parse(snooze.dueAt) <= now.getTime());
    if (reason === 'startup') {
      // Quitting never schedules OS notifications. Missed reminders become visible queue state, not a burst on restart.
      if (pastTime && !this.#ledger.days[clock.day]) this.#ledger.days[clock.day] = { status: 'missed', at: now.toISOString() };
      if (this.#ledger.pending || snoozeDue || pastTime) this.#phase = 'overdue'; else this.#phase = snooze ? 'snoozed' : 'scheduled';
      this.#ledger.pending = false; if (snoozeDue) this.#ledger.snooze = null; this.#save(); this.options.onChanged?.(); return this.status();
    }
    if (snooze && !snoozeDue) { this.#phase = 'snoozed'; return this.status(); }
    const dailyDue = !this.#ledger.days[clock.day] && (pastTime || this.#ledger.pending);
    if (!snoozeDue && !dailyDue) {
      this.#phase = snooze ? 'snoozed' : this.#ledger.days[clock.day]?.status === 'failed' ? 'failed' : this.#ledger.days[clock.day]?.status === 'sent' ? 'delivered' : this.#ledger.days[clock.day]?.status === 'missed' ? 'overdue' : 'scheduled';
      return this.status();
    }
    if (quietAt(clock.minute, this.#settings)) {
      if (dailyDue && !this.#ledger.pending) { this.#ledger.pending = true; this.#save(); }
      this.#phase = 'quiet'; this.options.onChanged?.(); return this.status();
    }
    const id = snoozeDue ? `snooze:${snooze!.token}` : `daily:${clock.day}`;
    // Claim before calling the OS. A crash or uncertain delivery cannot cause automatic duplicate attempts.
    this.#ledger.days[clock.day] = { status: 'sent', at: now.toISOString() };
    this.#ledger.pending = false; if (snoozeDue) this.#ledger.snooze = null;
    this.#ledger.lastError = null; this.#save(); this.#invalidate(); this.#currentNotification = id;
    const fail = (message: string) => {
      if (this.#currentNotification !== id) return;
      this.#ledger.days[clock.day] = { status: 'failed', at: now.toISOString() };
      this.#ledger.lastError = message.slice(0, 2000); this.#phase = 'failed'; this.#save(); this.options.onChanged?.();
    };
    try {
      await this.options.notifier.notify({ id, title: 'AlgoPractice · 复习提醒', body: `有 ${count} 项复习等待处理。打开今日队列继续练习。`, dueCount: count,
        onClick: () => { if (this.#active && this.#settings.enabled && this.#currentNotification === id && this.#clock().day === clock.day && this.#due() > 0) this.options.onNavigateQueue(); }, onFailure: fail });
      if (this.#currentNotification === id && this.#ledger.days[clock.day].status !== 'failed') {
        this.#ledger.lastDeliveredAt = now.toISOString(); this.#phase = 'delivered'; this.#save();
      }
    } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
    this.options.onChanged?.(); return this.status();
  }
}
