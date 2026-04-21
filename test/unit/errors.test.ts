import { describe, it, expect } from 'vitest';
import {
  NatsStorageError,
  NatsConnectionError,
  NatsNotInitializedError,
  isKeyNotFoundError,
} from '../../src/errors.js';

describe('NatsStorageError', () => {
  it('should have correct name and message', () => {
    const err = new NatsStorageError('test error');
    expect(err.name).toBe('NatsStorageError');
    expect(err.message).toBe('test error');
    expect(err).toBeInstanceOf(Error);
  });

  it('should store cause', () => {
    const cause = new Error('original');
    const err = new NatsStorageError('wrapped', cause);
    expect(err.cause).toBe(cause);
  });
});

describe('NatsConnectionError', () => {
  it('should have correct name', () => {
    const err = new NatsConnectionError('connection failed');
    expect(err.name).toBe('NatsConnectionError');
    expect(err).toBeInstanceOf(NatsStorageError);
  });
});

describe('NatsNotInitializedError', () => {
  it('should have descriptive message', () => {
    const err = new NatsNotInitializedError();
    expect(err.name).toBe('NatsNotInitializedError');
    expect(err.message).toContain('init()');
  });
});

describe('isKeyNotFoundError', () => {
  it('should return true for "no such key" error', () => {
    expect(isKeyNotFoundError(new Error('no such key'))).toBe(true);
  });

  it('should return true for "not found" error', () => {
    expect(isKeyNotFoundError(new Error('key not found'))).toBe(true);
  });

  it('should return false for other errors', () => {
    expect(isKeyNotFoundError(new Error('connection timeout'))).toBe(false);
  });

  it('should return false for non-Error values', () => {
    expect(isKeyNotFoundError('string')).toBe(false);
    expect(isKeyNotFoundError(null)).toBe(false);
    expect(isKeyNotFoundError(undefined)).toBe(false);
  });
});
