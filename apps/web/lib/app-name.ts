/**
 * The product name shown on sign-in pages, the browser tab and the sidebar
 * fallback. A self-hosted clinic can set NEXT_PUBLIC_APP_NAME at build time
 * to show its own name instead of "OpenVPM".
 */
export const DEFAULT_APP_NAME = "OpenVPM";

export const APP_NAME =
  process.env.NEXT_PUBLIC_APP_NAME?.trim() || DEFAULT_APP_NAME;
