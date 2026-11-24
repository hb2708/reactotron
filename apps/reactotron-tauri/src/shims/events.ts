type Listener = (...args: any[]) => void

export class EventEmitter {
  private events = new Map<string, Set<Listener>>()

  on(event: string, listener: Listener): this {
    if (!this.events.has(event)) this.events.set(event, new Set())
    this.events.get(event)!.add(listener)
    return this
  }

  addListener(event: string, listener: Listener): this {
    return this.on(event, listener)
  }

  off(event: string, listener: Listener): this {
    this.events.get(event)?.delete(listener)
    return this
  }

  removeListener(event: string, listener: Listener): this {
    return this.off(event, listener)
  }

  removeAllListeners(event?: string): this {
    if (event) this.events.delete(event)
    else this.events.clear()
    return this
  }

  emit(event: string, ...args: any[]): boolean {
    const set = this.events.get(event)
    if (!set || set.size === 0) return false
    set.forEach((fn) => fn(...args))
    return true
  }
}

export default EventEmitter
