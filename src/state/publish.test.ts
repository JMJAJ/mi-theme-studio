import { describe, expect, it } from 'vitest';

describe('publish flow helpers', () => {
  it('suggests only station tags found in the theme details', async () => {
    const { suggestTags } = await import('./publish');
    const groups = [
      { name: 'Content style', subTags: ['Cool', 'Dark', 'Retro'] },
      { name: 'Design genre', subTags: ['Anime', 'Art', 'Ukiyo-e'] },
    ];
    const info = {
      title: 'Vagabond',
      designer: '',
      author: '',
      version: '1.0',
      description: 'Miyamoto Musashi in ukiyo-e style, dark and cool',
      keywords: 'Anime, samurai',
      artworkFiles: 0,
      artworkBytes: 0,
      artwork: [],
      attributions: [],
    };
    expect(suggestTags(groups, info)).toEqual(['Cool', 'Dark', 'Anime', 'Ukiyo-e']);
    expect(suggestTags(groups, null)).toEqual([]);
  });

  it('lists what the store details still need', async () => {
    const { detailProblems } = await import('./publish');
    const form = { productName: 'Vagabond', versionName: '1.0', designerName: 'Jx', authorName: 'Jx', description: 'Musashi', talkToUs: '', changeLog: '' };
    expect(detailProblems({ form, tags: ['Cool'] })).toEqual([]);
    expect(detailProblems({ form: { ...form, productName: 'x'.repeat(19) }, tags: [] })).toEqual(['a theme name of up to 18 characters', 'at least one tag']);
  });

  it('words review states and update rules like the station', async () => {
    const { reviewState, canUpdate } = await import('./publish');
    expect(reviewState({ auditState: 'WAIT_SNAPSHOT' }).label).toBe('Making screenshots');
    expect(reviewState({ auditState: 'REJECTED' }).tone).toBe('red');
    expect(reviewState({ productStatus: 'ONLINE' }).label).toBe('Live');
    expect(canUpdate({ auditState: 'WAIT_AUDIT' })).toBe(false);
    expect(canUpdate({ auditState: 'REJECTED' })).toBe(true);
    expect(canUpdate({ productStatus: 'ONLINE' })).toBe(true);
  });

  it('asks for a new version number and change log on updates', async () => {
    const { detailProblems } = await import('./publish');
    const form = { productName: 'Vagabond', versionName: '1.0', designerName: 'Jx', authorName: 'Jx', description: 'x', talkToUs: '', changeLog: '' };
    const updateOf = { productId: 'p', productName: 'Vagabond', versionName: '1.0' };
    expect(detailProblems({ form, tags: ['Cool'], updateOf })).toEqual(['a version newer than 1.0', 'what changed in this version']);
    expect(detailProblems({ form: { ...form, versionName: '1.1', changeLog: 'New icons' }, tags: ['Cool'], updateOf })).toEqual([]);
  });
});
