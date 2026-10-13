/** Stable persisted language IDs; compiler backends are not extra user languages. */
export const LANGUAGES = ['python', 'java', 'go', 'cpp'] as const;
export type Language = (typeof LANGUAGES)[number];
export const LANGUAGE_DETAILS = {
  python: { label: 'Python', monacoLanguage: 'python', fileExtension: '.py', officialSlug: 'python3', environmentLabel: 'CPython 3.14.x' },
  java: { label: 'Java', monacoLanguage: 'java', fileExtension: '.java', officialSlug: 'java', environmentLabel: 'OpenJDK 25' },
  go: { label: 'Go', monacoLanguage: 'go', fileExtension: '.go', officialSlug: 'golang', environmentLabel: 'Go 1.27.x · 标准库' },
  cpp: { label: 'C++', monacoLanguage: 'cpp', fileExtension: '.cpp', officialSlug: 'cpp', environmentLabel: 'C++17 · Zig 0.16' },
} as const satisfies Record<Language, { label: string; monacoLanguage: string; fileExtension: string; officialSlug: string; environmentLabel: string }>;
export type OfficialLanguageSlug = (typeof LANGUAGE_DETAILS)[Language]['officialSlug'];
export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value);
}
export function languageLabel(language: Language): string { return LANGUAGE_DETAILS[language].label; }
export function languageFromOfficialSlug(value: unknown): Language | undefined {
  return LANGUAGES.find(language => LANGUAGE_DETAILS[language].officialSlug === value);
}
