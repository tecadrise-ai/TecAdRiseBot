/// <reference types="vite/client" />

import type { TecApi } from '../electron/preload';

declare global {
  interface Window {
    tecapi: TecApi;
  }
}

export {};
