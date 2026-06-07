import type { PlatformAdapter } from '../../shared/types/platform.types'
import { TaobaoPlatform } from './taobao/taobao.platform.new'
import { JdPlatform } from './jd/jd.platform'
import type { Database } from '../db/database'

export class PlatformRegistry {
  private adapters = new Map<string, PlatformAdapter>()

  constructor(db: Database) {
    this.register(new TaobaoPlatform(db))
    this.register(new JdPlatform(db))
  }

  register(adapter: PlatformAdapter) {
    this.adapters.set(adapter.name, adapter)
  }

  get(name: string): PlatformAdapter | undefined {
    return this.adapters.get(name)
  }

  getAll(): PlatformAdapter[] {
    return Array.from(this.adapters.values())
  }
}
