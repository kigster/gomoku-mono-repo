# DNS records for the Gomoku deployments

This doc covers the DNS records you need to add at your registrar
(DNSMadeEasy, in our case) so the Cloud Run domain mappings can finish
the TLS handshake.

There are two distinct cases — **apex** domains (`gomoku.us`) and
**subdomains** (`staging.gomoku.games`). They use different record
types, and Cloud Run serves them via different infrastructure.

## TL;DR

| Environment | Domain | DNS provider | Records | Source |
| ----------- | ---------------------- | ------------ | -------------------------------------------------- | ---------------------------------------------- |
| Production | `gomoku.us` | DNSMadeEasy | 4 × `A` (IPv4 ghs) + 4 × `AAAA` (IPv6 ghs) at apex | [§1](#1-production--gomokuus-apex) |
| Staging | `staging.gomoku.games` | DNSMadeEasy | 1 × `CNAME` → `ghs.googlehosted.com.` | [§2](#2-staging--staginggomokugames-subdomain) |
| Local dev | `dev.gomoku.games` | `/etc/hosts` | `127.0.0.1 dev.gomoku.games` | [§3](#3-local-dev--devgomokugames) |

For each environment, after the first `just deploy <env>` Terraform
prints the **exact** records to add. The values below are what Google
publishes today; if Terraform's output disagrees, follow Terraform.

## Why two record types?

`google_cloud_run_domain_mapping` (the resource we use) provisions
TLS automatically as long as you point DNS at Google. The DNS _target_
depends on whether the hostname is an apex or a subdomain:

- **Subdomain** (`staging.gomoku.games`) — a `CNAME` to
  `ghs.googlehosted.com.` is allowed by RFC 1034 and is what Google
  serves.
- **Apex** (`gomoku.us`) — RFC 1034 forbids `CNAME` at the zone apex
  alongside `SOA` and `NS` records, so Google publishes a fixed set of
  IPv4 (`A`) and IPv6 (`AAAA`) addresses to use instead.

Both forms still trigger Google's automatic Let's Encrypt TLS issuance
once the records propagate.

______________________________________________________________________

## 1. Production — `gomoku.us` (apex)

DNSMadeEasy supports two ways to point an apex at Google. Pick **one**;
do not configure both at the same time.

### Option A (recommended) — ANAME at the apex

DNSMadeEasy's `ANAME` record is a CNAME-at-apex flattener: it stores
a hostname target but resolves to A/AAAA records server-side at query
time, satisfying RFC 1034 while letting Google rotate the underlying
IPs without manual updates.

1. Log in at <https://cp.dnsmadeeasy.com/> and open the `gomoku.us`
   managed zone.
1. **Delete** any existing apex `A` / `AAAA` / `CNAME` records that
   currently point at the old host.
1. Add a single `ANAME` at the apex:
   - **Name**: (blank or `@`)
   - **Type**: `ANAME`
   - **Value**: `ghs.googlehosted.com.` (note the trailing dot)
   - **TTL**: `1800`

### Option B — explicit A + AAAA records

If you'd rather not depend on DNSMadeEasy's flattening, add these
**eight** records at the apex (Name = blank or `@`, TTL = `1800`):

```
A     216.239.32.21
A     216.239.34.21
A     216.239.36.21
A     216.239.38.21
AAAA  2001:4860:4802:32::15
AAAA  2001:4860:4802:34::15
AAAA  2001:4860:4802:36::15
AAAA  2001:4860:4802:38::15
```

### Subdomain & redirect (both options)

- Optionally add `www.gomoku.us` — `CNAME` → `ghs.googlehosted.com.`
  so visitors who type `www.gomoku.us` land in the right place.
- Set up the historical `app.gomoku.games` → `https://gomoku.us`
  redirect: in DNSMadeEasy, open the `gomoku.games` zone,
  **HTTP Redirection** panel, and add a 301 redirect.

### After DNS

Wait for DNS propagation (usually under 5 minutes with TTL=1800),
then run `just deploy` (or re-run if you already did). The first
apply creates the `google_cloud_run_domain_mapping`; subsequent
applies converge the rest. TLS provisioning takes 15–60 minutes
after the records resolve.

### Google domain-ownership verification (one-time, per Google account)

`google_cloud_run_domain_mapping` will fail with
`Domain ownership not verified` unless the GCP account performing
`terraform apply` has verified the domain via Google Search
Console. The verification artefact is a `TXT` record at the apex
of the form:

```
google-site-verification=<random-token>
```

Once the record is in DNS and you've completed the Search Console
"Verify" flow, the apex stays verified for that account
indefinitely — no DNS change is needed for subsequent deploys.

To check whether your active gcloud account already sees the
domain as verified:

```sh
gcloud domains list-user-verified
# Should list: gomoku.us
```

If it doesn't appear, sign in to
<https://search.google.com/search-console/welcome> as the same
Google account `gcloud config get-value account` reports, add
`gomoku.us` as a property, and click Verify — Search Console will
read the existing `TXT` and confirm immediately. No DNS edits
required.

The verification `TXT` and your SPF `TXT` (`v=spf1 ...`) are
independent records on the same name — both can (and should)
coexist.

### Verifying

Both options resolve identically over the wire — DNSMadeEasy flattens
the ANAME to the Google IPs at query time, so external resolvers see
A/AAAA records either way:

```sh
# DNS resolves to Google's IPs?
dig +short gomoku.us A
# Expect: 216.239.32.21 / .34 / .36 / .38 (in some order)

dig +short gomoku.us AAAA
# Expect: 2001:4860:4802:32::15 etc.

# TLS cert provisioned?
curl -sI https://gomoku.us | head -5
# Expect: HTTP/2 200, Server: Google Frontend
```

### What if I want `app.gomoku.us` instead of the apex?

Set `PRODUCTION_CUSTOM_DOMAIN="app.gomoku.us"` in `.env` and use the
subdomain pattern in [§2](#2-staging--staginggomokugames-subdomain) —
single `CNAME` to `ghs.googlehosted.com.`. Same TLS, fewer records.
The trade-off is that visitors typing the bare `gomoku.us` would land
nowhere unless you also configure an apex redirect (manually, via
DNSMadeEasy's HTTP redirect feature, or via a tiny redirect Cloud Run
service).

______________________________________________________________________

## 2. Staging — `staging.gomoku.games` (subdomain)

### Step-by-step in DNSMadeEasy

1. Open the `gomoku.games` managed zone.
1. Add a `CNAME` record:
   - **Name**: `staging`
   - **Type**: `CNAME`
   - **Value**: `ghs.googlehosted.com.` (note the trailing dot)
   - **TTL**: `1800`
1. Run `just deploy staging`. Wait 15–60 minutes for TLS provisioning.

### Verifying

```sh
dig +short staging.gomoku.games CNAME
# Expect: ghs.googlehosted.com.

curl -sI https://staging.gomoku.games | head -5
# Expect: HTTP/2 200, Server: Google Frontend
```

______________________________________________________________________

## 3. Local dev — `dev.gomoku.games`

The local cluster is fronted by nginx with mkcert-issued TLS. There is
**no DNS record** for `dev.gomoku.games` because we never want a
public hostname pointing at `127.0.0.1` (it both leaks the dev
hostname and confuses TLS verification).

Add it to `/etc/hosts` instead:

```
127.0.0.1   dev.gomoku.games
```

Then `bin/gctl start` and visit <https://dev.gomoku.games>. nginx
serves the locally-trusted certificate that `bin/gctl setup`
provisions via mkcert.

______________________________________________________________________

## Per-environment Terraform output

The exact records Terraform expects to be in DNS land in the deploy
output (and are queryable on demand):

```sh
# After a deploy:
cd iac/cloud_run
terraform output custom_domain_dns_records
```

The `[]` empty result means the apex/A records branch — refer to
[§1](#1-production--gomokuus-apex). A populated array means the
subdomain/CNAME branch — refer to [§2](#2-staging--staginggomokugames-subdomain).

## Troubleshooting

- **"This site can't be reached"** — DNS hasn't propagated yet.
  `dig +short <domain>` should return the Google IPs / CNAME above.
- **`SSL_ERROR_NO_CYPHER_OVERLAP`** in Firefox /
  `NET::ERR_CERT_AUTHORITY_INVALID` in Chrome — Google hasn't
  finished provisioning the cert. Wait up to an hour, then check the
  Cloud Console under **Cloud Run → Domain Mappings**.
- **Cloud Console shows "Domain ownership not verified"** — the
  records aren't pointing at Google yet. Re-check `dig` output and
  TTLs.
- **Nothing happens for hours** — DNSMadeEasy has propagated, but
  Google's verification cron didn't pick it up. Run
  `gcloud beta run domain-mappings describe --domain=<domain> --region=us-central1`
  and look at `status.conditions` for the actual reason.
