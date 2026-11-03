// Upstream computer/supervisor client (CORE, licence-free).
//
// Exact upstream protocol, not a reimplementation:
// - supervisor auth: `Authorization: Bearer <SUPERVISOR_TOKEN>` with
//   timingSafeEqual (supervisor/src/authorisation.ts). NOT HMAC.
// - computer auth: `x-openbot-computer-token: <COMPUTER_TOKEN>` +
//   `x-openbot-bot-id` / `x-openbot-person-id` seat headers
//   (server/src/computer/client.ts, provider.ts). NOT Authorization Bearer.
// - identity: /computers/person/<upstreamUserId> or /computers/bot/<botId>,
//   validated ^[A-Za-z0-9][A-Za-z0-9_-]*$ len<=64 (names.ts). Caller never
//   sends container names.
// - runtime path is the SERVER gateway /api/computers/:botId/... (app.ts
//   mounts /api/computers). Direct agent-computer:4100 is internal only.
//
// Home holds SUPERVISOR_TOKEN + COMPUTER_TOKEN server-side. Per-computer
// credentials never go to LLM/phone. No fallback to legacy runner: missing
// upstream returns NEEDS_SETUP/unavailable.

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const MAX_ID = 64;

export function checkUpstreamId(id, what = 'id') {
  if (typeof id !== 'string' || id.length === 0) throw upstreamComputerError(`A ${what} id is required`);
  if (id.length > MAX_ID) throw upstreamComputerError(`A ${what} id may be at most ${MAX_ID} characters`);
  if (!ID_RE.test(id)) {
    throw upstreamComputerError(`A ${what} id may contain only letters, digits, hyphen and underscore, and must start with a letter or digit`);
  }
  return id;
}

export function upstreamComputerError(message, code = 'upstream_unavailable') {
  return Object.assign(new Error(message), { code });
}

// Map a validated Me owner to the upstream person id. 1:1 server-side only.
// Default: stable 1:1 `u_<meUserId>` sanitized to upstream rules. Deployments
// with their own BetterAuth user table pass mapUser explicitly.
export function defaultUpstreamPersonId(meUserId) {
  const base = `u_${String(meUserId).replace(/[^A-Za-z0-9_-]/g, '_')}`.slice(0, MAX_ID);
  return checkUpstreamId(base, 'person');
}

export function supervisorPathFor(kind, id) {
  if (kind !== 'person' && kind !== 'bot') throw upstreamComputerError('computer belongs to a person or a bot');
  checkUpstreamId(id, kind);
  return kind === 'person'
    ? `/computers/person/${encodeURIComponent(id)}`
    : `/computers/bot/${encodeURIComponent(id)}`;
}

export function seatHeaders(botId, upstreamPersonId) {
  checkUpstreamId(botId, 'bot');
  const headers = { 'x-openbot-bot-id': botId };
  if (upstreamPersonId !== undefined && upstreamPersonId !== null) {
    headers['x-openbot-person-id'] = checkUpstreamId(upstreamPersonId, 'person');
  }
  return headers;
}

export function supervisorHeaders(supervisorToken) {
  if (!supervisorToken) throw upstreamComputerError('SUPERVISOR_TOKEN is required', 'upstream_not_configured');
  // Exact upstream derivation: `Bearer ${token}` (authorisation.ts).
  return { authorization: `Bearer ${supervisorToken}` };
}

export function computerHeaders(computerToken, botId, upstreamPersonId) {
  if (!computerToken) throw upstreamComputerError('COMPUTER_TOKEN is required', 'upstream_not_configured');
  return { 'x-openbot-computer-token': computerToken, ...seatHeaders(botId, upstreamPersonId) };
}

export function createSupervisorClient({ baseUrl, token, fetchImpl = fetch, timeoutMs = 120_000 } = {}) {
  if (!baseUrl) throw upstreamComputerError('COMPUTER_SUPERVISOR_URL is required', 'upstream_not_configured');
  const base = String(baseUrl).replace(/\/$/, '');
  const doFetch = fetchImpl;

  async function call(path, method = 'POST', body) {
    let res;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers: {
          ...supervisorHeaders(token),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError' && method === 'POST' && path.endsWith('/ensure')) {
        throw Object.assign(new Error('The computer is still starting. This call was not performed. Try it again in a moment.'), { code: 'upstream_starting', starting: true });
      }
      throw upstreamComputerError(`Supervisor unreachable: ${error instanceof Error ? error.message : String(error)}`);
    }
    const answer = await res.json().catch(() => null);
    if (!res.ok) {
      if (res.status === 503 && answer?.starting === true) {
        throw Object.assign(new Error(answer?.error ?? 'Computer starting'), { code: 'upstream_starting', starting: true });
      }
      const code = res.status === 401 ? 'upstream_unauthorized' : res.status === 409 ? 'upstream_conflict' : 'upstream_unavailable';
      throw Object.assign(new Error(answer?.error ?? `Supervisor answered ${res.status}`), { code, status: res.status });
    }
    return answer;
  }

  return {
    // personId MUST be the mapped upstream user id (server-side, from
    // validated Me session). Never a client-supplied value.
    ensurePerson(personId, { carryOver } = {}) {
      const path = `${supervisorPathFor('person', personId)}/ensure`;
      const body = carryOver !== undefined ? { carryOver } : undefined;
      // Empty body would still send {}; upstream treats empty text as no-carry.
      return body === undefined ? call(path, 'POST') : call(path, 'POST', body);
    },
    ensureBot(botId) {
      return call(`${supervisorPathFor('bot', botId)}/ensure`, 'POST');
    },
    stopPerson(personId) {
      checkUpstreamId(personId, 'person');
      return call(`/computers/person/${encodeURIComponent(personId)}/stop`, 'POST');
    },
    // Explicit verb helpers:
    stop(kind, id) {
      return call(`${supervisorPathFor(kind, id)}/stop`, 'POST');
    },
    reset(kind, id) {
      return call(`${supervisorPathFor(kind, id)}/reset`, 'POST');
    },
    list() {
      return call('/computers', 'GET');
    },
    health() {
      return doFetch(`${base}/health`, { signal: AbortSignal.timeout(timeoutMs) }).then((r) => r.json());
    },
  };
}

// Minimal server-gateway caller shape for B: builds fetch options for
// /api/computers/:botId/... with the mapped upstream session. Home session
// validation stays in infra-server; this helper only shapes the outbound call.
export function gatewayRequest({ gatewayBaseUrl, upstreamSessionToken, botId, method = 'GET', path, body }) {
  checkUpstreamId(botId, 'bot');
  if (!gatewayBaseUrl) throw upstreamComputerError('gateway base URL required', 'upstream_not_configured');
  if (!upstreamSessionToken) throw upstreamComputerError('upstream session required', 'upstream_not_configured');
  const url = `${String(gatewayBaseUrl).replace(/\/$/, '')}/api/computers/${encodeURIComponent(botId)}${path.startsWith('/') ? path : `/${path}`}`;
  return {
    url,
    init: {
      method,
      headers: {
        authorization: `Bearer ${upstreamSessionToken}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    },
  };
}
