export class AsyncLock {
  #wait: Promise<void> = Promise.resolve();

  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      this.#wait = this.#wait.then(() => {
        return new Promise((release) => resolve(release));
      });
    });
  }
}
