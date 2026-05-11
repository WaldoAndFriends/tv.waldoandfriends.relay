'use strict';

const Homey = require('homey');
const { fetchMasterFeed, fetchShowFeed } = require('./lib/RelayFeed');
const SHOWS = require('./lib/Shows');

const DEFAULT_POLL_INTERVAL = 15;
const MIN_POLL_INTERVAL = 1;
const MAX_SEEN_GUIDS = 50;

module.exports = class RelayApp extends Homey.App {

  async onInit() {
    this.log('Relay.fm app is initializing...');

    this._seenGuids = this.homey.settings.get('seenGuids') || [];
    this._lastPollTime = this.homey.settings.get('lastPollTime') || null;
    this._tokens = new Map();

    this._triggerCard = this.homey.flow.getTriggerCard('new_episode_released');

    this._triggerCard.registerRunListener(async (args, state) => {
      if (args.show === 'any') return true;
      return state.show_slug === args.show;
    });

    await this._createGlobalTokens();
    await this._seedTokensFromShowFeeds();

    this.homey.settings.on('set', (key) => {
      if (key === 'pollInterval') {
        this.log('Poll interval changed, restarting polling');
        this._startPolling();
      }
    });

    this._startPolling();

    this.log('Relay.fm app has been initialized');
  }

  async _createGlobalTokens() {
    const tokenDefs = [
      { suffix: 'episode_title', type: 'string', label: 'Episode Title', example: '178: The Process of Investigative Reporting' },
      { suffix: 'episode_media_url', type: 'string', label: 'Media URL', example: 'https://traffic.libsyn.com/cortex/Cortex_178.mp3' },
      { suffix: 'episode_number', type: 'number', label: 'Episode Number', example: 178 },
    ];
    for (const show of SHOWS) {
      if (!show.slug) continue;
      for (const def of tokenDefs) {
        const tokenId = `${show.slug.replace(/-/g, '_')}_${def.suffix}`;
        try {
          const token = await this.homey.flow.createToken(tokenId, {
            type: def.type,
            title: `${show.name} — ${def.label}`,
            example: def.example,
          });
          await token.setValue(def.type === 'number' ? 0 : '');
          this._tokens.set(tokenId, token);
        } catch (err) {
          this.error(`Failed to create token ${tokenId}:`, err.message);
        }
      }
    }
  }

  async _seedTokensFromShowFeeds() {
    for (const show of SHOWS) {
      if (!show.slug) continue;
      try {
        const episode = await fetchShowFeed(show.slug);
        if (episode) {
          await this._updateEpisodeTokens(episode);
        }
      } catch (err) {
        this.error(`Failed to seed tokens for ${show.slug}:`, err.message);
      }
    }
  }

  async _updateEpisodeTokens(episode) {
    const prefix = episode.show_slug.replace(/-/g, '_');
    const updates = [
      { suffix: 'episode_title', value: episode.episode_title },
      { suffix: 'episode_media_url', value: episode.episode_media_url },
      { suffix: 'episode_number', value: episode.episode_number || 0 },
    ];
    for (const { suffix, value } of updates) {
      const token = this._tokens.get(`${prefix}_${suffix}`);
      if (token && value != null) {
        await token.setValue(value).catch(this.error);
      }
    }
  }

  _getPollIntervalMinutes() {
    const val = this.homey.settings.get('pollInterval');
    if (val == null) return DEFAULT_POLL_INTERVAL;
    const num = parseInt(val, 10);
    if (Number.isNaN(num) || num < MIN_POLL_INTERVAL) return MIN_POLL_INTERVAL;
    return num;
  }

  _startPolling() {
    if (this._pollTimer) {
      this.homey.clearInterval(this._pollTimer);
    }

    const intervalMs = this._getPollIntervalMinutes() * 60 * 1000;
    this._pollTimer = this.homey.setInterval(() => {
      this._poll().catch(this.error);
    }, intervalMs);

    this._poll().catch(this.error);
  }

  async _poll() {
    this.log('Polling master feed...');

    try {
      const episodes = await fetchMasterFeed();
      const newEpisodes = [];

      for (const episode of episodes) {
        if (!this._seenGuids.includes(episode._guid)) {
          newEpisodes.push(episode);
        }
      }

      const guidsToAdd = episodes.map((e) => e._guid).filter((g) => g);
      this._seenGuids = [...new Set([...this._seenGuids, ...guidsToAdd])];
      if (this._seenGuids.length > MAX_SEEN_GUIDS) {
        this._seenGuids = this._seenGuids.slice(-MAX_SEEN_GUIDS);
      }
      this.homey.settings.set('seenGuids', this._seenGuids);

      this._lastPollTime = new Date().toISOString();
      this.homey.settings.set('lastPollTime', this._lastPollTime);

      const latestByShow = new Map();
      for (const episode of episodes) {
        if (episode.show_slug && !latestByShow.has(episode.show_slug)) {
          latestByShow.set(episode.show_slug, episode);
        }
      }

      for (const [, episode] of latestByShow) {
        await this._updateEpisodeTokens(episode).catch(this.error);
      }

      for (const episode of newEpisodes) {
        const tokens = {
          episode_title: episode.episode_title,
          episode_url: episode.episode_url,
          episode_media_url: episode.episode_media_url,
          show_name: episode.show_name,
          show_slug: episode.show_slug,
          episode_number: episode.episode_number || 0,
          episode_subtitle: episode.episode_subtitle,
          episode_duration: episode.episode_duration || 0,
          episode_published: episode.episode_published,
        };

        const state = {
          show_slug: episode.show_slug,
        };

        this.log(`New episode: ${episode.show_name} - ${episode.episode_title}`);
        await this._triggerCard.trigger(tokens, state).catch(this.error);
      }

      if (newEpisodes.length === 0) {
        this.log('No new episodes found');
      }
    } catch (err) {
      this.error('Poll failed:', err.message);
    }
  }

  async onUninit() {
    if (this._pollTimer) {
      this.homey.clearInterval(this._pollTimer);
    }
    for (const [, token] of this._tokens) {
      try {
        await token.unregister();
      } catch (_) {}
    }
    this._tokens.clear();
    this.log('Relay.fm app has been uninitialized');
  }

};
