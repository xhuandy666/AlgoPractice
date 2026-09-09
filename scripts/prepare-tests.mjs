import { mkdir } from 'node:fs/promises';
await mkdir(new URL('../evidence/', import.meta.url), { recursive: true });
