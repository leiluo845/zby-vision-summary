class TokenService {
  constructor({ appKey, appSecret, apiBaseUrl, fetchImpl = global.fetch }) {
    this.appKey = appKey;
    this.appSecret = appSecret;
    this.apiBaseUrl = apiBaseUrl.replace(/\/$/, "");
    this.fetchImpl = fetchImpl;
    this.cache = null;
  }

  async getAccessToken() {
    if (this.cache && this.cache.expiresAt > Date.now()) {
      return this.cache.token;
    }

    if (!this.appKey || !this.appSecret) {
      throw new Error("Missing DINGTALK_APP_KEY or DINGTALK_APP_SECRET.");
    }

    const response = await this.fetchImpl(`${this.apiBaseUrl}/v1.0/oauth2/accessToken`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        appKey: this.appKey,
        appSecret: this.appSecret,
      }),
    });

    const payloadText = await response.text();
    let payload = null;
    try {
      payload = payloadText ? JSON.parse(payloadText) : {};
    } catch {
      payload = { raw: payloadText };
    }

    if (!response.ok) {
      throw new Error(`Failed to obtain DingTalk access token: ${payloadText}`);
    }

    const token = payload.accessToken || payload.access_token;
    const expireIn = Number(payload.expireIn || payload.expiresIn || payload.expires_in || 7200);
    if (!token) {
      throw new Error(`DingTalk token response did not include accessToken: ${payloadText}`);
    }

    this.cache = {
      token,
      expiresAt: Date.now() + Math.max(300, expireIn - 300) * 1000,
    };

    return token;
  }
}

module.exports = {
  TokenService,
};
