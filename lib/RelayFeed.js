'use strict';

const { XMLParser } = require('fast-xml-parser');
const SHOWS = require('./Shows');

const MASTER_FEED_URL = 'https://www.relay.fm/master/feed';
const SHOW_FEED_URL = 'https://www.relay.fm/{slug}/feed';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
});

const SLUG_MAP = new Map();
for (const show of SHOWS) {
  if (show.slug) {
    SLUG_MAP.set(show.slug, show);
    SLUG_MAP.set(show.name.toLowerCase(), show);
  }
}

function normalizeString(value) {
  if (value == null) return '';
  if (typeof value === 'object') {
    if (typeof value['#text'] === 'string') return value['#text'].trim();
    return '';
  }
  return typeof value === 'string' ? value.trim() : value;
}

function parseEpisode(item, showName) {
  const title = item['itunes:title'] || item.title || '';
  const link = normalizeString(item.link);
  const guid = item.guid && typeof item.guid === 'object' ? item.guid['#text'] : (item.guid || '');
  const subtitle = item['itunes:subtitle'] || '';
  const duration = parseInt(item['itunes:duration'] || '0', 10) || 0;
  const pubDate = item.pubDate || '';
  const enclosure = item.enclosure || {};
  const mediaUrl = enclosure['@_url'] || '';

  let episodeNumber = parseInt(item['itunes:episode'] || '0', 10) || null;
  if (episodeNumber === null) {
    const linkMatch = link.match(/relay\.fm\/[a-z0-9-]+\/(\d+)/i);
    if (linkMatch) episodeNumber = parseInt(linkMatch[1], 10);
  }

  const slugMatch = link.match(/relay\.fm\/([a-z0-9-]+)/i);
  const showSlug = slugMatch ? slugMatch[1] : '';

  return {
    episode_title: normalizeString(title),
    episode_url: link,
    episode_media_url: normalizeString(mediaUrl),
    show_name: normalizeString(showName),
    show_slug: showSlug,
    episode_number: episodeNumber,
    episode_subtitle: normalizeString(subtitle),
    episode_duration: duration,
    episode_published: normalizeString(pubDate),
    _guid: normalizeString(guid),
  };
}

function findShowSlugFromItem(item) {
  const link = item.link || '';
  const slugMatch = link.match(/relay\.fm\/([a-z0-9-]+)\/\d+/i);
  if (slugMatch) return slugMatch[1];
  return '';
}

function findShowBySlug(slug) {
  return SLUG_MAP.get(slug) || null;
}

async function fetchFeed(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching ${url}`);
  }
  const xml = await response.text();
  return parser.parse(xml);
}

async function fetchFirstItemXml(url) {
  const controller = new AbortController();
  const chunks = [];
  let length = 0;
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} fetching ${url}`);
    }
    if (response.body && typeof response.body.getReader === 'function') {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        length += value.length;
        if (Buffer.concat(chunks, length).includes('</item>')) break;
      }
    } else {
      chunks.push(Buffer.from(await response.text(), 'utf8'));
    }
  } finally {
    controller.abort();
  }

  const data = Buffer.concat(chunks, length);
  const idx = data.indexOf('</item>');
  if (idx === -1) {
    return parser.parse(data);
  }
  return parser.parse(Buffer.concat([data.slice(0, idx + '</item>'.length), Buffer.from('</channel></rss>')]));
}

async function fetchMasterFeed() {
  const data = await fetchFeed(MASTER_FEED_URL);
  const channel = data.rss && data.rss.channel ? data.rss.channel : {};
  const items = channel.item || [];
  const episodes = [];

  const itemList = Array.isArray(items) ? items : [items];
  for (const item of itemList) {
    const slug = findShowSlugFromItem(item);
    const showInfo = findShowBySlug(slug);
    const showName = showInfo ? showInfo.name : slug;
    episodes.push(parseEpisode(item, showName));
  }

  return episodes;
}

async function fetchShowFeed(slug) {
  const url = SHOW_FEED_URL.replace('{slug}', slug);
  const data = await fetchFirstItemXml(url);
  const channel = data.rss && data.rss.channel ? data.rss.channel : {};
  const showName = channel.title || slug;
  const items = channel.item || [];
  const itemList = Array.isArray(items) ? items : [items];

  return parseEpisode(itemList[0], showName);
}

module.exports = {
  fetchMasterFeed,
  fetchShowFeed,
  findShowBySlug,
  SHOWS,
};
