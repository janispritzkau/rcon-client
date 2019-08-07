
interface QueuedItem<T> {
    promiseGenerator: () => Promise<T>
    resolve: (value: T) => any
    reject: (reason?: any) => any
}

export class PromiseQueue {
    paused = false
    private queue: QueuedItem<any>[] = []
    private pendingPromiseCount = 0

    constructor(public maxConcurrent = 1) { }

    async add<T>(promiseGenerator: () => Promise<T>) {
        return new Promise<T>((resolve, reject) => {
            this.queue.push({ promiseGenerator, resolve, reject })
            this.dequeue()
        })
    }

    pause() {
        this.paused = true
    }

    resume() {
        this.paused = false
        this.dequeue()
    }

    private async dequeue() {
        if (this.paused || this.pendingPromiseCount >= this.maxConcurrent) return

        const item = this.queue.shift()
        if (!item) return

        this.pendingPromiseCount++
        
        try {
            const value = await item.promiseGenerator()
            item.resolve(value)
        } catch (error) {
            item.reject(error)
        } finally {
            this.pendingPromiseCount--
            this.dequeue()
        }
    }
}
