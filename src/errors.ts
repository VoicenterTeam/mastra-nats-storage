export class NatsStorageError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'NatsStorageError';
  }
}

export class NatsConnectionError extends NatsStorageError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'NatsConnectionError';
  }
}

export class NatsNotInitializedError extends NatsStorageError {
  constructor() {
    super('NATS KV storage has not been initialized. Call init() first.');
    this.name = 'NatsNotInitializedError';
  }
}

export function isKeyNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes('no such key') ||
      error.message.includes('not found'))
  );
}
