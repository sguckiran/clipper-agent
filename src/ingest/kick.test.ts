import { describe, expect, it } from 'vitest';
import { isKickVodUrl, pickMasterPlaylist } from './kick.js';

describe('isKickVodUrl', () => {
  it('matches Kick VOD page URLs', () => {
    expect(isKickVodUrl('https://kick.com/krimoe/videos/019f68d4-abc')).toBe(true);
    expect(isKickVodUrl('https://www.kick.com/foo/videos/xyz')).toBe(true);
  });
  it('rejects non-VOD or non-Kick URLs', () => {
    expect(isKickVodUrl('https://kick.com/krimoe')).toBe(false);
    expect(isKickVodUrl('https://www.youtube.com/watch?v=abc')).toBe(false);
    expect(isKickVodUrl('not a url')).toBe(false);
  });
});

describe('pickMasterPlaylist', () => {
  const cf =
    'https://d26yk4zpyhjeeq.cloudfront.net/v1/master/hash/production-kick-vod-csb/tok/ivs/v1/x/media/hls/master.m3u8?aws.sessionId=abc';

  it('prefers a signed CloudFront master playlist', () => {
    const urls = [
      'https://kick.com/whatever.js',
      'https://stream.kick.com/tok/ivs/v1/x/media/hls/720p30/1.ts',
      cf,
      'https://d26yk4zpyhjeeq.cloudfront.net/v1/manifest/hash/sess/0.m3u8',
    ];
    expect(pickMasterPlaylist(urls)).toBe(cf);
  });

  it('falls back to any master then any m3u8', () => {
    expect(pickMasterPlaylist(['https://x/media/hls/master.m3u8'])).toBe(
      'https://x/media/hls/master.m3u8',
    );
    expect(pickMasterPlaylist(['https://x/variant/2.m3u8'])).toBe('https://x/variant/2.m3u8');
  });

  it('returns undefined when no playlist is present', () => {
    expect(pickMasterPlaylist(['https://x/a.ts', 'https://x/app.js'])).toBeUndefined();
  });
});
