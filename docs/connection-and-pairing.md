# Protected home endpoint and phone pairing

Design proposal updated 2026-11-03 from the user's clarification. No tunnel,
provider account, public endpoint, credential exchange, or pairing service has
been provisioned or implemented by this document. The frontend remains a living
prototype; define service contracts independently of its current screens.

## Product requirement

During home setup, establish a stable protected public endpoint through
Cloudflare Tunnel or an equivalent connector. Enroll phones through a one-time
activation/pairing handshake. Normal home API access requires an authorized
paired phone and its household user. Knowing the public hostname alone must not
grant access to conversations, files, tasks, browser sessions, or model tools.

The hosted Me backend still participates in accounts, home discovery/registration,
pairing coordination and notifications. Whether it relays all private traffic or
paired phones use the tunnel endpoint directly is a separate routing decision.
Recommended arrangement to validate:

```text
Phone <-> Me hosted backend       accounts, discovery, pairing coordination
Phone <-> protected tunnel URL <-> home infra-server   private home API
Home  <-> Me hosted backend       registration, status, notification coordination
```

The earlier always-through-backend data path is not a fixed requirement after
this clarification. If a relay is chosen, the home must still verify paired-device
and user authorization on forwarded requests. Backend login, device pairing,
and household membership are separate checks.

## Proposed enrollment sequence

1. `setup-infra` installs the home service and tunnel connector, establishes the
   home's installation identity, and registers the endpoint with the backend.
   Configure protection before publishing a route; start closed on failure.
2. An authorized person starts pairing locally for the first owner, or through
   an already authorized admin session for later devices. The home creates a
   short-lived, high-entropy, single-use invitation. A QR payload can carry the
   home ID/address, installation identity reference, invitation ID, and pairing
   secret. Logs/analytics must redact the secret.
3. The phone authenticates to the Me account, verifies the intended home, and
   creates its own device key/credential using maintained authentication tooling
   and platform key storage. Prefer keeping private keys on the device; hardware
   backing depends on the selected native implementation and must be tested.
4. A narrow pairing exchange presents the invitation and proves possession of
   the device credential. Bind the request to the intended home, user, device
   key and protocol version. An account token alone cannot claim a home.
5. The home validates invitation expiry/scope, user authorization and any admin
   confirmation, then atomically consumes the invitation and enrolls the device.
   Invitation consumption and device creation must not leave a reusable half-
   enrolled state. Define safe retry/status recovery without allowing an invite
   to enroll a second device.
6. The phone receives its own revocable enrollment/session material and confirms
   the home identity. Subsequent API calls use authenticated sessions bound to
   the device; short-lived tokens are renewed through the registered device
   credential. Use a supported authentication/proof-of-possession implementation,
   not a new cryptographic protocol assembled from ad hoc signatures.
7. The home checks device enrollment, current revocation and household/user
   permissions before serving private resources or starting agent work.

The invitation is used once; authentication continues on later requests. Session
renewal must not require repeating setup. A new phone or reinstallation that
loses its device credential requires a new authorized enrollment.

## Keep credential purposes separate

| Credential | Holder/use | Lifecycle |
| --- | --- | --- |
| Pairing invitation secret | Initial exchange between setup/authorized admin and phone | Short-lived, single-use, narrowly scoped; store a verifier where practical |
| Phone device key/enrollment | That phone; home stores its authorized public identity/verifier | Per device, revocable, renewed/rotated according to selected protocol |
| Home API session token | Authorized phone; audience is the particular home/API | Short-lived, scoped to device/user; validate against current enrollment |
| Home installation identity | Home service; registered public identity shared with paired clients/backend as designed | Persistent, with authenticated rotation and recovery |
| Tunnel connector credential | Home connector; provider administration provisions it | Never included in a phone pairing QR or general API token |
| Provider administration credential | Trusted provisioning component only | Least privilege, independently rotated; never a mobile credential |
| Optional SSH administration credential | Separately authorized maintenance channel | Separate from normal agent use and family data access |

Normal phone chat/task access should use the application API. SSH provisioning,
if supported, needs its own explicit administrative scope; ordinary pairing does
not require sharing the computer's SSH private key or root access. Do not share
one permanent home bearer token across every family phone.

## Tunnel protection and bootstrap

[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/)
uses an outbound connector from the home to Cloudflare. It provides reachability
without requiring an inbound home listener exposed to the public Internet.
Access protection is separate from merely creating that route.

Cloudflare documents [protecting a self-hosted application](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)
with Access and recommends creating protection before the route. If Access is
used, validate its token at the origin as documented. Its identity/policy checks
do not replace Me's own household/device/resource authorization.

Select native-client-compatible edge admission: supported login, device-bound
certificate/token integration, or a scoped backend-mediated gateway. Evaluate
this end to end before picking a mechanism. A standard account login alone does
not prove that this particular phone was paired.

Define how a not-yet-paired phone reaches enrollment without already having the
normal edge credential. Options are backend-mediated enrollment or a tightly
limited pairing service with its own short-lived admission. Never bypass
protection for the entire home API just to make pairing work. Anonymous health
responses, if any, reveal only deliberately chosen minimal readiness information.

[Cloudflare service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
are separate client-ID/secret credentials. They are not automatically a one-use
phone handshake. If selected for an edge integration, define per-device scope,
storage, rotation and revocation; never embed a shared fleet-wide secret in the
app. Keep provider credential headers distinct from home API authorization.

Use a managed stable hostname/endpoint for an installed home. Cloudflare
[Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)
are documented for development/testing, not the durable household deployment.
Provider choice, account/domain ownership, credential provisioning, quotas and
endpoint recovery remain deployment decisions.

Only publish the intended application gateway. Bind internal model, database,
worker and management services to their private interfaces. Apply authentication
and resource ownership to event streams, artifacts, browser previews and uploads
as well as chat. HTTPS/tunneling alone does not establish application-level
end-to-end encryption; provider termination and payload-encryption boundaries
must be explicit before making private-content visibility claims.

## Household lifecycle and acceptance

Each person can have multiple enrolled phones; each phone has a distinct device
identity. Pairing is not a permission to read every household member's history.
Shared-device user switching requires authorized sessions and cache isolation.
Admins need a device inventory, invitation expiry/cancel controls, revocation,
and a home-owner recovery process. Define what admin powers actually include.

Revocation should terminate applicable home streams/sessions and prevent renewal,
with edge credentials revoked as needed. If a revocation originates in the hosted
backend while the home is disconnected, specify delivery and stale-credential
windows honestly. Do not promise instantaneous global revocation merely because
tokens have expiry fields.

Acceptance cases: an unpaired phone knows the URL but gets no private data;
expired/reused invites fail; two phones race for one invite and at most one is
enrolled; an invite cannot be redirected to another home/user/key; replayed
proofs fail; partial enrollment retries cannot create extra devices; revoked
phones lose further access; another family member's IDs fail authorization;
hostname/key rotation is authenticated; tunnel failure causes an offline state;
app/home restarts preserve intended enrollment; and no secret appears in logs.

Implementation spans `setup-infra` (installation/bootstrap), `infra-server`
(pairing records/device sessions/access checks), `backend-server` (account and
home coordination), and `phone-app` (scan/confirm/store/renew/revoke UX). Reuse
provider and authentication components for those mechanisms. The agent framework
receives trusted identity/scopes and does not implement the pairing protocol.
