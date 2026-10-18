/** Shared by the bounded server downloader and the browser-only PDF parser. */
export const DATASHEET_LIMITS = { fileBytes: 12 * 1024 * 1024, pages: 60, characters: 250_000, milliseconds: 45_000 } as const
