import { readFile, writeFile, rename } from 'node:fs/promises'

/** API keys of paired OpenCPN instances, keyed by the `source` they send. */
export class KeyStore {
  private keys = new Map<string, string>()

  constructor(private readonly file?: string) {}

  async load(): Promise<void> {
    if (!this.file) return
    try {
      const data: unknown = JSON.parse(await readFile(this.file, 'utf8'))
      if (data && typeof data === 'object') {
        for (const [source, key] of Object.entries(data)) {
          if (typeof key === 'string') this.keys.set(source, key)
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  get(source: string): string | undefined {
    return this.keys.get(source)
  }

  has(source: string, key: string): boolean {
    return this.keys.get(source) === key
  }

  async set(source: string, key: string): Promise<void> {
    this.keys.set(source, key)
    await this.save()
  }

  async delete(source: string): Promise<void> {
    if (this.keys.delete(source)) await this.save()
  }

  sources(): string[] {
    return [...this.keys.keys()]
  }

  private async save(): Promise<void> {
    if (!this.file) return
    const tmp = `${this.file}.tmp`
    await writeFile(tmp, JSON.stringify(Object.fromEntries(this.keys), null, 2), {
      mode: 0o600
    })
    await rename(tmp, this.file)
  }
}
