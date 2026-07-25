import { describe, expect, it, vi } from 'vitest';
import { retry } from './retry.js';

const noSleep = vi.fn().mockResolvedValue(undefined);

describe('retry', () => {
  it('returns immediately on success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    expect(await retry(fn, { sleep: noSleep })).toBe('ok');
    expect(fn).toHaveBeenCalledOnce();
  });

  it('retries then succeeds', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('flaky')).mockResolvedValue('ok');
    const onRetry = vi.fn();
    expect(await retry(fn, { retries: 3, sleep: noSleep, onRetry })).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('throws the last error after exhausting retries', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('down'));
    await expect(retry(fn, { retries: 2, sleep: noSleep })).rejects.toThrow('down');
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('uses exponential backoff delays', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fn = vi.fn().mockRejectedValue(new Error('x'));
    await expect(retry(fn, { retries: 3, baseDelayMs: 100, sleep })).rejects.toThrow();
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([100, 200, 400]);
  });
});
