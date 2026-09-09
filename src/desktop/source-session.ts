import { BrowserWindow, session, type Session } from 'electron';
import { LeetCodeCnSourceAdapter } from '../source/index';

export class SourceSession {
  readonly session: Session;
  readonly adapter: LeetCodeCnSourceAdapter;
  #window: BrowserWindow | null = null;
  constructor() {
    this.session = session.fromPartition('persist:leetcode-cn');
    this.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    this.session.setPermissionCheckHandler(() => false);
    this.session.on('will-download', event => event.preventDefault());
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.protocol !== 'https:' || url.hostname !== 'leetcode.cn' || url.port || url.username || url.password) throw new Error('来源请求仅允许力扣国服。');
      return this.session.fetch(url.href, { ...init, credentials: 'include', redirect: 'manual' });
    };
    this.adapter = new LeetCodeCnSourceAdapter({ fetchImpl, sessionMode: 'user-session' });
  }
  async state() {
    const cookies = await this.session.cookies.get({ url: 'https://leetcode.cn' });
    return { hasSession: cookies.some(cookie => cookie.name === 'LEETCODE_SESSION' && (!cookie.expirationDate || cookie.expirationDate * 1000 > Date.now())) };
  }
  async open() {
    if (this.#window && !this.#window.isDestroyed()) { this.#window.show(); this.#window.focus(); return; }
    const login = new BrowserWindow({ title: '力扣国服 · 账号登录', width: 1040, height: 760, autoHideMenuBar: true,
      webPreferences: { session: this.session, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
    });
    this.#window = login;
    const allow = (url: string) => { try { const u = new URL(url); return u.protocol === 'https:' && u.hostname === 'leetcode.cn' && !u.port && !u.username && !u.password; } catch { return false; } };
    login.webContents.on('will-navigate', (event, url) => { if (!allow(url)) event.preventDefault(); });
    login.webContents.on('will-redirect', (event, url) => { if (!allow(url)) event.preventDefault(); });
    login.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    login.on('closed', () => { this.#window = null; });
    await login.loadURL('https://leetcode.cn/');
  }
  async clear() { this.#window?.close(); await this.session.clearStorageData(); await this.session.clearCache(); }
  close() { this.#window?.close(); }
}
