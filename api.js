'use strict';

module.exports = {
  async check({ homey }) {
    await homey.app._poll();
    return { ok: true };
  },
};
