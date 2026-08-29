/// <reference types="vite/client" />

import type { HolodoriApi } from '@shared/api'

declare global {
  interface Window {
    holodori: HolodoriApi
  }
}

export {}
