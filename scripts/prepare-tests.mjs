import { prepareWindowsHelper } from './prepare-windows-helper.mjs';
import { mkdir } from 'node:fs/promises';
await mkdir(new URL('../evidence/', import.meta.url), { recursive: true });
await prepareWindowsHelper();
