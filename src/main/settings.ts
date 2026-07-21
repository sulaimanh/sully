import { EventEmitter } from 'events'
import type { AppSettings } from '../shared/types'
import { defaultSettings } from '../shared/types'
import { SETTINGS_FILE, readJson, writeJsonAtomic } from './paths'

class SettingsStore extends EventEmitter {
  private settings: AppSettings

  constructor() {
    super()
    // Deep-merge stored settings over defaults so new fields get sane values
    // when the app updates.
    const stored = readJson<Partial<AppSettings>>(SETTINGS_FILE, {})
    const base = defaultSettings()
    this.settings = {
      ...base,
      ...stored,
      phases: {
        planning: { ...base.phases.planning, ...stored.phases?.planning },
        coding: { ...base.phases.coding, ...stored.phases?.coding },
        createPr: { ...base.phases.createPr, ...stored.phases?.createPr },
        commitPush: { ...base.phases.commitPush, ...stored.phases?.commitPush },
        addressComments: { ...base.phases.addressComments, ...stored.phases?.addressComments },
        prReview: { ...base.phases.prReview, ...stored.phases?.prReview },
        errorInvestigation: {
          ...base.phases.errorInvestigation,
          ...stored.phases?.errorInvestigation
        }
      },
      orchestrator: { ...base.orchestrator, ...stored.orchestrator },
      prWatcher: { ...base.prWatcher, ...stored.prWatcher },
      toolHealth: { ...base.toolHealth, ...stored.toolHealth },
      errorTracking: { ...base.errorTracking, ...stored.errorTracking }
    }
  }

  get(): AppSettings {
    return this.settings
  }

  set(next: AppSettings): void {
    this.settings = next
    writeJsonAtomic(SETTINGS_FILE, next)
    this.emit('changed', next)
  }

  update(patch: (s: AppSettings) => AppSettings): AppSettings {
    this.set(patch(structuredClone(this.settings)))
    return this.settings
  }
}

export const settingsStore = new SettingsStore()
