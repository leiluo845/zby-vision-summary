class DingTalkApiClient {
  constructor({ apiBaseUrl, tokenService, fetchImpl = global.fetch }) {
    this.apiBaseUrl = apiBaseUrl.replace(/\/$/, "");
    this.tokenService = tokenService;
    this.fetchImpl = fetchImpl;
  }

  async request(pathname, options = {}) {
    const accessToken = await this.tokenService.getAccessToken();
    const url = pathname.startsWith("http")
      ? pathname
      : `${this.apiBaseUrl}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
    const headers = {
      "Content-Type": "application/json; charset=utf-8",
      "x-acs-dingtalk-access-token": accessToken,
      ...(options.headers || {}),
    };

    const response = await this.fetchImpl(url, {
      method: options.method || "GET",
      headers,
      body: options.body == null ? undefined : JSON.stringify(options.body),
    });

    const payloadText = await response.text();
    let payload = null;

    try {
      payload = payloadText ? JSON.parse(payloadText) : {};
    } catch {
      payload = { raw: payloadText };
    }

    if (!response.ok) {
      throw new Error(`DingTalk API request failed (${response.status}): ${payloadText}`);
    }

    return payload;
  }
}

module.exports = {
  DingTalkApiClient,
};
