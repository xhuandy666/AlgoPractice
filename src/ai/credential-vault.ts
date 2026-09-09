import { mkdir, lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AiProviderConfig } from '../shared/ai.ts';
import { canonicalJson, completionEndpoint, sha256 } from './canonical.ts';
import { AiServiceError } from './errors.ts';

/** Inject Electron safeStorage after app.whenReady(); test doubles do not prove OS integration. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
  isAsyncEncryptionAvailable?(): Promise<boolean>;
  encryptStringAsync?(plainText: string): Promise<Buffer>;
  decryptStringAsync?(encrypted: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
  getSelectedStorageBackend?(): string;
}
interface EncryptedCredential { schemaVersion: 1; bindingHash: string; ciphertext: string; }
export class CredentialVault {
  readonly directory: string;
  readonly #safeStorage: SafeStorageLike;
  readonly #platform: string;
  #queue: Promise<void> = Promise.resolve();
  constructor(options: { directory: string; safeStorage: SafeStorageLike; platform?: string }) {
    this.directory = resolve(options.directory); this.#safeStorage = options.safeStorage; this.#platform = options.platform ?? process.platform;
  }
  #binding(config: AiProviderConfig) { const binding = { providerId: config.id, endpoint: completionEndpoint(config) }; return { ...binding, hash: sha256(canonicalJson(binding)) }; }
  #path(config: AiProviderConfig) { return join(this.directory, `ai-${this.#binding(config).hash}.credential`); }
  #serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation); this.#queue = result.then(() => undefined, () => undefined); return result;
  }
  async secureStorageAvailable(): Promise<boolean> {
    try {
      if (this.#platform === 'linux' && ['basic_text', 'unknown'].includes(this.#safeStorage.getSelectedStorageBackend?.() ?? 'unknown')) return false;
      return this.#safeStorage.isAsyncEncryptionAvailable ? await this.#safeStorage.isAsyncEncryptionAvailable() : this.#safeStorage.isEncryptionAvailable();
    } catch { return false; }
  }
  async #directory(create: boolean): Promise<boolean> {
    if (create) await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try { const stat = await lstat(this.directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new AiServiceError('CREDENTIAL_UNAVAILABLE'); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !create) return false; throw new AiServiceError('CREDENTIAL_UNAVAILABLE'); }
  }
  async #read(config: AiProviderConfig): Promise<EncryptedCredential | null> {
    if (!await this.#directory(false)) return null;
    try {
      const path = this.#path(config); const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new AiServiceError('CREDENTIAL_UNAVAILABLE');
      const data = JSON.parse(await readFile(path, 'utf8')) as EncryptedCredential;
      if (data.schemaVersion !== 1 || data.bindingHash !== this.#binding(config).hash || typeof data.ciphertext !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(data.ciphertext) || data.ciphertext.length > 48000) throw new AiServiceError('CREDENTIAL_UNAVAILABLE');
      return data;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new AiServiceError('CREDENTIAL_UNAVAILABLE'); }
  }
  async hasKey(config: AiProviderConfig): Promise<boolean> { return this.#serial(async () => Boolean(await this.#read(config))); }
  async #write(config: AiProviderConfig, ciphertext: Buffer): Promise<void> {
    await this.#directory(true);
    const path = this.#path(config), temporary = `${path}.${randomUUID()}.partial`;
    try {
      // Validate an existing target before replacing it, never follow a credential symlink.
      await this.#read(config);
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(canonicalJson({ schemaVersion: 1, bindingHash: this.#binding(config).hash, ciphertext: ciphertext.toString('base64') })); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, path);
    } finally { await unlink(temporary).catch(() => {}); }
  }
  async setKey(config: AiProviderConfig, key: string): Promise<{ hasKey: true }> {
    return this.#serial(async () => {
      if (typeof key !== 'string' || !key.trim() || key.length > 8192 || /[\u0000-\u001f\u007f]/.test(key)) throw new AiServiceError('INVALID_REQUEST');
      if (!await this.secureStorageAvailable()) throw new AiServiceError('CREDENTIAL_UNAVAILABLE');
      const { providerId, endpoint } = this.#binding(config);
      try {
        const plaintext = canonicalJson({ providerId, endpoint, key: key.trim() });
        const encrypted = this.#safeStorage.encryptStringAsync ? await this.#safeStorage.encryptStringAsync(plaintext) : this.#safeStorage.encryptString(plaintext);
        if (!Buffer.isBuffer(encrypted) || !encrypted.length) throw new AiServiceError('CREDENTIAL_UNAVAILABLE');
        await this.#write(config, encrypted); return { hasKey: true };
      } catch { throw new AiServiceError('CREDENTIAL_UNAVAILABLE'); }
    });
  }
  async clearKey(config: AiProviderConfig): Promise<void> {
    return this.#serial(async () => { try { if (!await this.#directory(false)) return; await unlink(this.#path(config)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new AiServiceError('CREDENTIAL_UNAVAILABLE'); } });
  }
  /** Main-process-only scope; do not expose this operation through IPC. */
  async withKey<T>(config: AiProviderConfig, operation: (key: string) => Promise<T>): Promise<T> {
    const key = await this.#serial(async () => {
      if (!await this.secureStorageAvailable()) throw new AiServiceError('CREDENTIAL_UNAVAILABLE');
      const credential = await this.#read(config); if (!credential) throw new AiServiceError('NOT_CONFIGURED');
      try {
        const encrypted = Buffer.from(credential.ciphertext, 'base64');
        const result = this.#safeStorage.decryptStringAsync ? await this.#safeStorage.decryptStringAsync(encrypted) : { result: this.#safeStorage.decryptString(encrypted), shouldReEncrypt: false };
        const decoded = JSON.parse(result.result) as { providerId: string; endpoint: string; key: string };
        const binding = this.#binding(config);
        if (decoded.providerId !== binding.providerId || decoded.endpoint !== binding.endpoint || typeof decoded.key !== 'string' || !decoded.key || decoded.key.length > 8192 || /[\u0000-\u001f\u007f]/.test(decoded.key)) throw new AiServiceError('CREDENTIAL_UNAVAILABLE');
        return decoded.key;
      } catch { throw new AiServiceError('CREDENTIAL_UNAVAILABLE'); }
    });
    return operation(key);
  }
}
