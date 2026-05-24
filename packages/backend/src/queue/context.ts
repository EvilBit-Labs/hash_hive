import type { QueueManager } from './manager.js'

let instance: QueueManager | null = null

export function getQueueManager(): QueueManager | null {
  return instance
}

export function setQueueManager(manager: QueueManager): void {
  instance = manager
}
