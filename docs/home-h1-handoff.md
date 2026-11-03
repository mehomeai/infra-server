# H1 integration handoff — home service slice

Authoritative contract: `contracts/home-api-v1.md` (+
`contracts/home-api-v1.openapi.json`). This note is the launch/integration
pointer for the other workers; on any conflict the contract file wins.

## What H1 delivers

Persistent installation identity, household users, owner-scoped
conversations/messages, local-bootstrap single-use pairing invitations consumed
atomically, distinct revocable device credentials + short-lived session tokens,
health/readiness, and SQLite restart persistence. No model output: H1 stores
caller-submitted `role: "user"` messages only.

## Run it (no dependencies to install; Node 24.18.x, stdlib only)

```sh
node src/cli.mjs seed-dev --db=data/home.sqlite   # DEVELOPMENT ONLY: alice/bob
node src/cli.mjs start --db=data/home.sqlite --host=127.0.0.1 --port=7070
curl http://127.0.0.1:7070/healthz
npm run test:home
```

Importable lifecycle for cross-repo harnesses:

```js
import { createHomeServer } from './src/server.mjs';
const server = createHomeServer({ dbPath: 'data/home.sqlite' });
await server.start({ host: '127.0.0.1', port: 0 });
await server.stop(); // data persists in the SQLite file
```

Local pairing bootstrap (on-host CLI; filesystem access is the authorization):

```sh
node src/cli.mjs bootstrap --user=alice --db=data/home.sqlite
# {"installation_id":"...","user_id":"alice","invitation_id":"inv_...","invitation_secret":"...","expires_at":...}
curl -X POST http://127.0.0.1:7070/v1/pair \
  -H 'content-type: application/json' \
  -d '{"invitation_id":"inv_...","invitation_secret":"...","device_label":"alice phone"}'
# {"device_id":"dev_...","device_secret":"<once>","user_id":"alice","installation_id":"..."}
curl -X POST http://127.0.0.1:7070/v1/sessions \
  -H 'content-type: application/json' \
  -d '{"device_id":"dev_...","device_secret":"..."}'
# {"token":"ht1_...","expires_at":...,"user_id":"alice","device_id":"dev_..."}
curl http://127.0.0.1:7070/v1/conversations -H "Authorization: Bearer ht1_..."
```

Default bind is loopback. Binding elsewhere prints a warning and is only for a
provisioned protected endpoint (tunnel + edge admission), which H1 does not set
up.

## For the other workers

- `phone-app`: pair via `POST /v1/pair`, keep `device_secret` in platform key
  storage, renew `ht1_` tokens via `POST /v1/sessions`; conversations/messages
  per the contract. Expect `404` for other-household-member resources.
- `backend-server`: no coordination endpoint in H1; account/home routing stays
  your design space. Home identity to rendezvous on is `installation_id`
  (see `GET /healthz`).
- `setup-infra`: own the installer; this service needs only a data dir + the
  `start` command + `bootstrap` for the first owner. Preserve the SQLite file
  across upgrades; deleting it resets installation identity.
- `agentic-framework`: conversation IDs (`conv_...`) are stable references you
  can attach runs to; the `spikes/openmuse` worker fixture is untouched and H1
  messages do not auto-enqueue worker tasks.
- Acceptance covered by `npm run test:home`: cross-user rejection,
  expired/reused invitation rejection, two-phone race enrolls at most one,
  revocation cuts access + renewal, restart preserves installation/chats.

## Still prototype-only (do not treat as production)

Single-host SQLite; JSON-body device-secret transport valid for loopback only;
no hosted account coordination, hardware-backed keys, or pairing
proof-of-possession; opaque bearer sessions with re-issue renewal only;
revocation enforced per-request at the home with no edge/offline propagation.
