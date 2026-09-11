/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Optional build-time API origin, e.g. `https://reef-api.example.com`.
   * When empty (default) the client uses same-origin relative URLs.
   */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
