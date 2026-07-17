import type { SullyApi } from './index'

declare global {
  interface Window {
    sully: SullyApi
  }
}

export {}
