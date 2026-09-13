/** Invoked through the trusted app IPC wrapper; never exposes clipboard reads to the renderer. */
export function writeCodeToClipboard(value: unknown, clipboard: { writeText(text: string): void }): void {
  // Same UTF-8 byte budget as main.ts codeValue, including an exact 1 MiB payload.
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 1048576) throw new Error('代码必须是不超过 1 MiB 的文本。');
  clipboard.writeText(value);
}
