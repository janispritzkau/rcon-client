
interface QueuedItem<T> {
  promiseGenerator: () => Promise<T>
  resolve: (value: T) => any
  reject: (e) => any
}

export class PromiseQueue {
  // could maybe replaced with a faster queue class
  private queue: QueuedItem<any>[] = []
  private pendingPromisesCount = 0
  private maxConcurrent: number
  private paused = false

  constructor(options?: {maxConcurrent?: number}) {
    if (!options) options = {}
    this.maxConcurrent = options.maxConcurrent || 1
  }

  add<T>(promiseGenerator: () => Promise<T>) {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({promiseGenerator, resolve, reject})
      if (!this.paused) this.dequeue()
    })
  }

  pause() {
    this.paused = true
  }

  resume() {
    this.paused = false
    this.dequeue()
  }

  private dequeue() {
    if (this.pendingPromisesCount > this.maxConcurrent || this.paused) return

    let item = this.queue.shift()
    if (!item) return

    this.pendingPromisesCount++

    let onPromiseResolvedOrRejected = () => {
      this.pendingPromisesCount--
      this.dequeue()
    }

    item.promiseGenerator()
    .then(value => {
      item.resolve(value)
      onPromiseResolvedOrRejected()
    })
    .catch(e => {
      item.reject(e)
      onPromiseResolvedOrRejected()
    })
  }
}
