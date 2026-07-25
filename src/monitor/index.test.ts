import { describe, expect, it, vi } from 'vitest';
import type { JobQueue } from '../core/queue.js';
import {
  buildListArgs,
  ChannelMonitor,
  MemorySeenStore,
  parseListOutput,
  YtDlpChannelLister,
  type ChannelLister,
} from './index.js';

describe('buildListArgs', () => {
  it('flat-lists recent videos', () => {
    const args = buildListArgs('https://twitch.tv/foo', 5);
    expect(args).toContain('--flat-playlist');
    expect(args).toContain('%(url)s');
    expect(args[args.indexOf('--playlist-end') + 1]).toBe('5');
    expect(args[args.length - 1]).toBe('https://twitch.tv/foo');
  });
});

describe('parseListOutput', () => {
  it('keeps only URL lines', () => {
    expect(parseListOutput('https://a.tv/1\n  \nnoise\nhttps://a.tv/2\n')).toEqual([
      'https://a.tv/1',
      'https://a.tv/2',
    ]);
  });
});

describe('YtDlpChannelLister', () => {
  it('runs yt-dlp and parses URLs', async () => {
    const runner = {
      run: vi.fn().mockResolvedValue({ stdout: 'https://a.tv/1', stderr: '', exitCode: 0 }),
    };
    const lister = new YtDlpChannelLister({ runner, binary: 'yt-dlp' });
    expect(await lister.listVideos('https://a.tv')).toEqual(['https://a.tv/1']);
  });
});

describe('ChannelMonitor', () => {
  function fakeQueue() {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    return { queue: { enqueue } as unknown as JobQueue, enqueue };
  }

  it('enqueues only new URLs and remembers them', async () => {
    const { queue, enqueue } = fakeQueue();
    const lister: ChannelLister = {
      listVideos: vi.fn().mockResolvedValue(['https://a.tv/1', 'https://a.tv/2']),
    };
    const monitor = new ChannelMonitor({ queue, lister, seen: new MemorySeenStore() });

    const first = await monitor.poll(['https://a.tv']);
    expect(first).toEqual(['https://a.tv/1', 'https://a.tv/2']);
    expect(enqueue).toHaveBeenCalledTimes(2);

    const second = await monitor.poll(['https://a.tv']);
    expect(second).toEqual([]);
    expect(enqueue).toHaveBeenCalledTimes(2); // nothing new
  });

  it('continues past a failing channel', async () => {
    const { queue, enqueue } = fakeQueue();
    const lister: ChannelLister = {
      listVideos: vi
        .fn()
        .mockRejectedValueOnce(new Error('down'))
        .mockResolvedValueOnce(['https://b.tv/1']),
    };
    const monitor = new ChannelMonitor({ queue, lister, seen: new MemorySeenStore() });
    const enqueued = await monitor.poll(['https://a.tv', 'https://b.tv']);
    expect(enqueued).toEqual(['https://b.tv/1']);
    expect(enqueue).toHaveBeenCalledOnce();
  });
});
