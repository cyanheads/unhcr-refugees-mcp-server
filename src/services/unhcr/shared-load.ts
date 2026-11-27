/**
 * @fileoverview Single-flight loading with independent deadlines for waiters.
 * @module services/unhcr/shared-load
 */

import { JsonRpcErrorCode, McpError, timeout } from '@cyanheads/mcp-ts-core/errors';

interface Flight<T> {
  deadlineAt: number;
  value: Promise<T>;
}

/** A spent load or waiter budget. Caller-facing recovery is added at the service boundary. */
export function loadDeadline(): McpError {
  return timeout('The UNHCR request budget expired.', { reason: 'retry_deadline_exceeded' });
}

/** Recognize an absolute load deadline, including the one enforced by the retry loop. */
export function isLoadDeadline(error: unknown): boolean {
  return (
    error instanceof McpError &&
    error.code === JsonRpcErrorCode.Timeout &&
    error.data?.reason === 'retry_deadline_exceeded'
  );
}

/** Share one producer per key while letting waiters spend their own budgets. */
export class SharedLoad<T> {
  private readonly flights = new Map<string, Flight<T>>();

  async get(
    key: string,
    deadlineAt: number,
    load: () => Promise<T>,
    waiterSignal?: AbortSignal,
  ): Promise<T> {
    while (true) {
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) throw loadDeadline();
      const flight = this.flights.get(key);
      if (!flight) {
        const value = load().finally(() => this.flights.delete(key));
        this.flights.set(key, { deadlineAt, value });
        return value;
      }
      if (deadlineAt < flight.deadlineAt) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            flight.value,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(loadDeadline()), remainingMs);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      }
      try {
        return await flight.value;
      } catch (error) {
        if (flight.deadlineAt >= deadlineAt || !isLoadDeadline(error)) throw error;
        waiterSignal?.throwIfAborted();
      }
    }
  }
}
