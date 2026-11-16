import type { ClientRequest, ClientRequestConstructorOptions, IncomingMessage } from 'electron';
import type { Readable } from 'node:stream';
import type { UpdateFetch } from './update-installer';

export type UpdateRequestFactory = (options: ClientRequestConstructorOptions) => ClientRequest;
const HIGH_WATER_MARK = 64 * 1024;
const MAX_QUEUED_BYTES = 1024 * 1024;
const CREDENTIAL_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'cookie2', 'x-github-token', 'x-access-token', 'x-api-key']);
// Electron can emit an error even after its writable request has closed. Keep only this stateless guard after cleanup.
const ignoreLateError = () => {};
const abortError = () => new DOMException('The operation was aborted.', 'AbortError');

function responseHeaders(values: Record<string, string | string[]>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(values)) {
    if (name.toLowerCase() === 'set-cookie') continue;
    for (const entry of Array.isArray(value) ? value : [value]) headers.append(name, entry);
  }
  return headers;
}

/** Credential-free GET transport. Redirect decisions stay in update-installer, including every allowed-host check. */
export function createUpdateFetch(requestFactory: UpdateRequestFactory): UpdateFetch {
  return async (url, init = {}) => {
    if ((init.method ?? 'GET').toUpperCase() !== 'GET' || init.body != null) throw new Error('Update requests only support GET without a body.');
    if (init.redirect !== undefined && !['manual', 'error'].includes(init.redirect)) throw new Error('Update redirects must be handled explicitly.');
    const address = new URL(url);
    if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password) throw new Error('Invalid update request URL.');
    const headers = new Headers(init.headers);
    for (const name of headers.keys()) if (CREDENTIAL_HEADERS.has(name)) throw new Error('Update requests cannot contain credentials.');
    const outgoingHeaders = Object.fromEntries(headers);
    const signal = init.signal;
    signal?.throwIfAborted();

    return new Promise<Response>((resolve, reject) => {
      let request: ClientRequest | undefined, incoming: (IncomingMessage & Readable) | undefined;
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      let settled = false, terminal = false;
      const cleanup = () => {
        signal?.removeEventListener('abort', onSignalAbort);
        if (request) {
          request.removeListener('response', onResponse); request.removeListener('redirect', onRedirect);
          request.removeListener('abort', onRequestAbort); request.removeListener('error', onRequestError);
          request.on('error', ignoreLateError);
        }
        if (incoming) {
          incoming.removeListener('end', onEnd); incoming.removeListener('data', onData);
          incoming.removeListener('aborted', onRequestAbort); incoming.removeListener('close', onResponseClose);
          incoming.removeListener('error', onRequestError); incoming.on('error', ignoreLateError);
        }
      };
      const stop = (error?: unknown, abort = false, cancelled = false) => {
        if (terminal) return;
        terminal = true;
        if (error !== undefined) {
          if (!settled) { settled = true; reject(error); }
          else controller?.error(error);
        } else if (!cancelled) controller?.close();
        cleanup();
        // Mark terminal and install the late-error guard before abort can synchronously emit events.
        if (abort) { try { request?.abort(); } catch { /* The request is already terminal. */ } }
      };
      const onSignalAbort = () => stop(signal?.reason ?? abortError(), true);
      const onRequestAbort = () => stop(abortError(), true);
      const onRequestError = (error: Error) => stop(error, true);
      const onResponseClose = () => { if (!terminal) stop(new Error('Update response closed before its body ended.'), true); };
      const onEnd = () => stop();
      const onData = (chunk: Buffer) => {
        if (terminal || !controller) return;
        const queued = HIGH_WATER_MARK - (controller.desiredSize ?? 0);
        if (chunk.byteLength + queued > MAX_QUEUED_BYTES) { stop(new Error('Update response exceeded its bounded stream buffer.'), true); return; }
        controller.enqueue(new Uint8Array(chunk));
        if ((controller.desiredSize ?? 0) <= 0) incoming?.pause();
      };
      const onRedirect = (statusCode: number, _method: string, location: string, values: Record<string, string[]>) => {
        if (terminal) return;
        if (init.redirect !== 'manual') { stop(new Error('Update request redirects are not allowed.'), true); return; }
        try {
          const response = responseHeaders(values); response.set('location', location);
          const result = new Response(null, { status: statusCode, headers: response });
          settled = true; resolve(result); stop(undefined, true);
        } catch (error) { stop(error, true); }
      };
      const onResponse = (message: IncomingMessage) => {
        if (terminal) return;
        try {
          // Electron 44's implementation extends Node Readable; its generated declarations omit that inheritance.
          // See electron/electron v44.2.0, lib/common/api/net-client-request.ts: IncomingMessage._read/_pushInternalData.
          incoming = message as IncomingMessage & Readable;
          incoming.pause();
          const options = { status: message.statusCode, statusText: message.statusMessage, headers: responseHeaders(message.headers) };
          if ([204, 205, 304].includes(message.statusCode)) {
            const result = new Response(null, options); settled = true; resolve(result); stop(undefined, true); return;
          }
          const body = new ReadableStream<Uint8Array>({
            start(value) { controller = value; },
            pull() { if (!terminal) incoming?.resume(); },
            cancel() { stop(undefined, true, true); },
          }, { highWaterMark: HIGH_WATER_MARK, size: chunk => chunk.byteLength });
          // Register end/error before data: attaching data may start Electron's buffered stream.
          incoming.on('end', onEnd); incoming.on('aborted', onRequestAbort);
          incoming.on('error', onRequestError); incoming.on('close', onResponseClose); incoming.on('data', onData);
          const result = new Response(body, options); settled = true; resolve(result);
        } catch (error) { stop(error, true); }
      };
      try {
        request = requestFactory({ url, method: 'GET', headers: Object.keys(outgoingHeaders).length ? outgoingHeaders : undefined,
          credentials: 'omit', useSessionCookies: false, redirect: 'manual', cache: init.cache ?? 'no-store',
          referrerPolicy: 'no-referrer', bypassCustomProtocolHandlers: true });
        request.on('error', onRequestError); request.on('abort', onRequestAbort);
        request.on('response', onResponse); request.on('redirect', onRedirect);
        signal?.addEventListener('abort', onSignalAbort, { once: true });
        if (signal?.aborted) onSignalAbort(); else request.end();
      } catch (error) { stop(error, true); }
    });
  };
}
