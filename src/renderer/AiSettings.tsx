import { useEffect, useRef, useState } from 'react';
import type { DesktopBridge } from '../shared/bridge';
import { aiCompletionEndpoint } from '../shared/ai-endpoint';
import { AI_PROVIDER_PRESETS, createAiProviderPreset } from '../shared/ai';
import type { AiConnectionResult, AiProviderConfig, AiProviderState } from '../shared/ai';
import { errorText, dateTime } from './ui';
import { useEditsFrozen } from './pending-saves';

const initial: AiProviderConfig = { id: '', ...AI_PROVIDER_PRESETS[0].config };
export function AiSettings({ api, onError }: { api: DesktopBridge | undefined; onError: (message: string) => void }) {
  const [provider, setProvider] = useState<AiProviderState | null>(null);
  const [form, setForm] = useState(initial); const [key, setKey] = useState('');
  const [busy, setBusy] = useState(''); const [message, setMessage] = useState('');
  const [connection, setConnection] = useState<AiConnectionResult | null>(null);
  const working = useRef(false); const frozen = useEditsFrozen();
  const locked = !provider || Boolean(busy) || frozen;
  useEffect(() => { let alive = true; if (api) void api.aiProvider().then(value => { if (alive) { setProvider(value); setForm(value.config ?? initial); } }).catch(error => onError(errorText(error))); return () => { alive = false; }; }, [api]);
  const selectedPreset = AI_PROVIDER_PRESETS.find(preset => preset.config.baseUrl === form.baseUrl && preset.config.model === form.model && preset.config.compatibility === form.compatibility);
  const dirty = JSON.stringify(form) !== JSON.stringify(provider?.config ?? initial) || Boolean(key);
  function update<K extends keyof AiProviderConfig>(field: K, value: AiProviderConfig[K]) { setForm(previous => ({ ...previous, [field]: value })); setMessage(''); setConnection(null); }
  async function save() {
    if (!api || !provider || working.current || frozen) return;
    const secret = key.trim();
    let addressChanged = false;
    try { const endpoint = aiCompletionEndpoint(form.baseUrl); addressChanged = Boolean(provider?.config && aiCompletionEndpoint(provider.config.baseUrl) !== endpoint); } catch (error) { onError(errorText(error)); return; }
    if (addressChanged && provider?.hasKey && !secret) { onError('接口地址已经改变，请重新输入对应的 API Key 后保存。'); return; }
    working.current = true; setBusy('save'); setMessage(''); setConnection(null);
    const config = { ...form, baseUrl: form.baseUrl.trim(), model: form.model.trim(), id: provider?.config && !addressChanged ? provider.config.id : crypto.randomUUID() };
    try {
      const pending = api.saveAiProvider(config, secret || undefined); setKey('');
      const value = await pending; setProvider(value); setForm(value.config ?? initial); setMessage(value.hasKey ? '配置已保存，Key 已交由系统加密存储。' : '接口设置已保存，添加 Key 后可测试连接。');
    } catch (error) { onError(errorText(error)); } finally { working.current = false; setBusy(''); }
  }
  async function testConnection() {
    if (!api || working.current || dirty || frozen) return;
    working.current = true; setBusy('test'); setMessage(''); setConnection(null);
    try { setConnection(await api.testAiProvider()); } catch (error) { onError(errorText(error)); } finally { working.current = false; setBusy(''); }
  }
  async function clearKey() {
    if (!api || !provider || working.current || frozen) return; working.current = true; setBusy('clear');
    try { const value = await api.clearAiKey(); setProvider(value); setKey(''); setConnection(null); setMessage('当前接口保存的 API Key 已清除。'); }
    catch (error) { onError(errorText(error)); } finally { working.current = false; setBusy(''); }
  }
  return <section className="settings-section" aria-labelledby="ai-settings-title"><div><h3 id="ai-settings-title">AI 接口</h3><p>使用你自己的兼容接口与模型。主动请求帮助时，会发送当前题面、代码、相关运行和你选中的笔记。</p><p>Key 不进入普通设置、日志或备份，界面只显示是否配置。</p></div>
    <form className="p3-form" onSubmit={event => { event.preventDefault(); void save(); }}>
      <label>模型提供商<select aria-label="模型提供商" value={selectedPreset?.id ?? 'custom'} disabled={locked} onChange={event => { setForm(event.target.value === 'custom' ? { ...form, compatibility: 'openai-compatible' } : createAiProviderPreset(event.target.value, crypto.randomUUID())); setConnection(null); setMessage(''); }}>
        {AI_PROVIDER_PRESETS.map(preset => <option key={preset.id} value={preset.id}>{preset.label}</option>)}<option value="custom">自定义兼容接口</option>
      </select></label>
      {selectedPreset && <p className="field-help">{selectedPreset.description} <button type="button" className="text-button" onClick={() => { void api?.openWebLink(selectedPreset.docsUrl).catch(error => onError(errorText(error))); }}>提供商说明</button></p>}
      <label>接口地址<input type="url" required value={form.baseUrl} placeholder="https://你的提供商/v1" disabled={locked} onChange={event => update('baseUrl', event.target.value)} /></label>
      <label>模型名称<input required value={form.model} placeholder="填写提供商支持的模型名称" disabled={locked} onChange={event => update('model', event.target.value)} /></label>
      <label>API Key<input type="password" autoComplete="off" spellCheck={false} value={key} disabled={locked || provider?.secureStorageAvailable === false} placeholder={provider?.hasKey ? '已保存；留空保留，输入可替换' : '粘贴后点击保存'} onChange={event => { setKey(event.target.value); setMessage(''); }} /></label>
      {provider?.secureStorageAvailable === false && <p className="field-help error-text">系统加密存储当前不可用，暂时不能保存 Key。</p>}
      <details><summary>模型参数与兼容选项</summary><div className="p3-form">
        <label>适配协议<select aria-label="适配协议" value={form.compatibility ?? 'openai-compatible'} disabled={locked} onChange={event => { update('compatibility', event.target.value as AiProviderConfig['compatibility']); if (event.target.value === 'glm' && form.temperature > 1) update('temperature', 1); }}><option value="deepseek">DeepSeek</option><option value="glm">GLM</option><option value="qwen">Qwen</option><option value="openai-compatible">通用 OpenAI 兼容</option></select></label>
        <div className="form-columns"><label>温度<input type="number" min="0" max={form.compatibility === 'glm' ? '1' : '2'} step="0.01" value={form.temperature} disabled={locked} onChange={event => update('temperature', Number(event.target.value))} /></label><label>最多输出 Token<input type="number" min="256" max="8192" step="256" value={form.maxOutputTokens} disabled={locked} onChange={event => update('maxOutputTokens', Number(event.target.value))} /></label></div>
        <label>请求超时（秒）<input type="number" min="5" max="180" value={form.timeoutMs / 1000} disabled={locked} onChange={event => update('timeoutMs', Number(event.target.value) * 1000)} /></label>
        <label className="checkbox-field"><input type="checkbox" checked={form.jsonMode} disabled={locked} onChange={event => update('jsonMode', event.target.checked)} />提供商支持 JSON 模式</label>
        <label className="checkbox-field"><input type="checkbox" checked={form.includeUsage} disabled={locked} onChange={event => update('includeUsage', event.target.checked)} />请求流式用量信息</label>
        <p className="field-help">若提供商拒绝可选参数，可关闭后重新测试。用量未返回时显示未知。</p>
      </div></details>
      <div className="compact-actions"><button type="submit" className="button primary" disabled={!api || locked || !dirty || !form.baseUrl.trim() || !form.model.trim()}>{busy === 'save' ? '正在保存…' : '保存 AI 设置'}</button><button type="button" className="button" disabled={!provider?.hasKey || locked || dirty} onClick={() => { void testConnection(); }}>{busy === 'test' ? '正在测试…' : '测试连接'}</button><button type="button" className="text-button" disabled={!provider?.hasKey || locked} onClick={() => { void clearKey(); }}>清除 Key</button></div>
      <p className="local-status">{!provider ? '正在读取配置…' : provider.hasKey ? 'Key 已配置' : '尚未配置 Key'}{dirty ? ' · 有待保存的设置' : ''}</p>
      {message && <p role="status" className="success-text">{message}</p>}
      {connection && <div role={connection.status === 'passed' ? 'status' : 'alert'}><strong className={connection.status === 'passed' ? 'success-text' : 'error-text'}>{connection.status === 'passed' ? '连接与结构化响应验证通过' : connection.error?.message || '连接尚未通过'}</strong><p className="field-help">{dateTime(connection.testedAt)} · {connection.model} · 流式传输：{connection.streaming === null ? '未知' : connection.streaming ? '可用' : '未验证'} · 用量：{connection.usage?.totalTokens ?? '未知'}</p></div>}
    </form>
  </section>;
}
