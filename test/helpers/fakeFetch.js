/**
 * Scripted fetch stand-in: each handler receives (url, init) and returns { status, json }
 * Requests are recorded so tests can assert on URLs, headers, and bodies
 */
function fakeFetch(handlers) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    const call = { url: String(url), method: init.method, headers: init.headers || {}, body: init.body };
    calls.push(call);
    const handler = handlers.find((candidate) => candidate.match(call));
    if (!handler) {
      throw new Error(`Unexpected request ${call.method} ${call.url}`);
    }
    const reply = typeof handler.reply === 'function' ? handler.reply(call) : handler.reply;
    const status = reply.status ?? 200;
    return {
      status,
      ok: status >= 200 && status < 300,
      text: async () => JSON.stringify(reply.json ?? {}),
    };
  };
  fetchFn.calls = calls;
  return fetchFn;
}

/**
 * Return each reply in order for successive matching requests, repeating the last one
 */
function sequence(...replies) {
  let index = 0;
  return () => replies[Math.min(index++, replies.length - 1)];
}

const silentLog = { debug() {}, info() {}, warn() {}, error() {} };

module.exports = { fakeFetch, sequence, silentLog };
