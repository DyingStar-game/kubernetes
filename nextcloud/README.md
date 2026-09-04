# Nextcloud — 3D asset library

Nextcloud for the DyingStar 3D modelers: a shared `.blend` library, **public in
read-only**, **writable by a named list of people authenticated with their GitHub
account**, with the files themselves living on the **TrueNAS** box so ZFS
snapshots and replication do the backup work.

Deployed to `dyingstar-dev-shared` on the `dyingstar` cluster. **Everything but
the TrueNAS box runs inside that namespace** — including a Keycloak instance of
its own, independent from the prod and preprod ones.

```
      cloud.dev.dyingstar-game.space          auth.dev.dyingstar-game.space
                    │ 443                              │ 443
   ┌────────────────▼──────────────────────────────────▼────────────────┐
   │ Traefik Gateway (namespace traefik)                                │
   │   listener "nextcloud"   → nextcloud-tls                           │
   │   listener "keycloakdev" → keycloak-dev-tls                        │
   │   both issued by cert-manager, ClusterIssuer letsencrypt           │
   └────────────────┬──────────────────────────────────┬────────────────┘
                    │ HTTPRoute                        │ HTTPRoute
   ┌────────────────▼──────────────────────────────────▼────────────────┐
   │ namespace dyingstar-dev-shared                                     │
   │                                                                    │
   │   nextcloud (apache) ──► nextcloud-postgresql   (local-path)       │
   │      │   │           └─► nextcloud-redis        (file locking)     │
   │      │   │                                                         │
   │      │   └─── OIDC ────► keycloak ──► keycloak-postgresql          │
   │      │                      │                                      │
   │      │ /var/www/html/data   │   nextcloud-db-backup (nightly dump) │
   │      │ (NFS, RWX)           │            │                         │
   │      │                      │            │                         │
   │   (dev-services-postgis also lives here, unrelated to Nextcloud)   │
   └──────┼──────────────────────┼────────────┼─────────────────────────┘
          │                      │ OAuth2     │
          ▼                      ▼            ▼
   truenas:…/nextcloud/data   github.com   truenas:…/nextcloud/backup
          └─ ZFS dataset + periodic snapshot task covers both
```

## Design decisions

| Decision | Why |
|---|---|
| Static NFS `PersistentVolume`, not dynamic provisioning | You asked for TrueNAS snapshots. Snapshots belong to a ZFS dataset you manage on TrueNAS; a dynamically provisioned volume would hand that lifecycle to Kubernetes. A static PV keeps TrueNAS in charge and survives `helm uninstall`. |
| Keycloak in front of GitHub | GitHub is plain OAuth2 — no OIDC discovery, no `id_token` — so Nextcloud's `user_oidc` cannot talk to it directly. Keycloak brokers it, and gives group membership on top, which is what drives write access. |
| A Keycloak instance *in this namespace*, not the prod one | The namespace stays self-contained: no cross-namespace dependency, and a mistake made wiring up the asset library cannot reach player authentication. It runs the upstream image (`quay.io/keycloak/keycloak`), not the DyingStar one, which would import the `dyingstar` player realm and expect Discord credentials. |
| Realm `dyingstar-studio`, not `master` | `master` is the admin realm; applications never belong in it. |
| Group Folder, not a user's home folder | A `groupfolders` folder belongs to no one, so a modeler leaving does not take the library with them. Per-group ACLs are exactly the read/write split you want. |
| Our own PostgreSQL + Redis | The upstream chart bundles the Bitnami subcharts, whose images moved to `bitnamilegacy`. These match the pattern already used by `keycloak/` and `livekit/`. |
| PostgreSQL on `local-path`, not NFS | A PostgreSQL data directory on NFS is a known corruption source. It is covered instead by the nightly `pg_dump` written *onto* the TrueNAS volume, so the ZFS snapshots capture files and database together. |
| Redis is not optional | Nextcloud's transactional file locking goes through Redis. Two modelers saving the same `.blend` at once on a network share without it is how you lose a file. |

---

## Order of operations

Nextcloud is installed **last** — everything it depends on has to exist first.
Sections 1 to 3 all run while there is no Nextcloud yet.

| # | Step | Section |
|---|---|---|
| 1 | TrueNAS dataset, NFS share, snapshot tasks | §1 |
| 2 | GitHub OAuth App | §2.1 |
| 3 | Keycloak deployed in `dyingstar-dev-shared` | §2.2 |
| 4 | Realm, client, groups, GitHub IdP | §2.3 |
| 5 | Traefik listeners synced + DNS records | §3 |
| 6 | Secrets, then `helm install` Nextcloud | §4 |
| 7 | Public read-only share link | §5 |
| 8 | Grant write access to the first modelers | §7.1 |

---

## 1. TrueNAS

### 1.1 Dataset

TrueNAS UI → **Datasets** → *Add Dataset*, under your pool:

| Setting | Value |
|---|---|
| Name | `dyingstar/nextcloud` (any path — note it, it goes in `values-dev-shared.yaml`) |
| Dataset Preset | **Generic** (not SMB — we need POSIX semantics) |
| ACL Type | **POSIX** |
| Case Sensitivity | Sensitive |
| Record Size | `1M` — `.blend` files are large sequential blobs |
| Compression | `lz4` (`.blend` files are already compressed; lz4 costs nothing and skips incompressible blocks) |
| Quota | whatever you want to cap the library at |

### 1.2 Pre-create the sub-directories

Kubernetes mounts `data/` and `backup/` as `subPath`s and **kubelet creates them
as root**. Create them yourself, owned by `www-data` (uid/gid **33**, the user the
Nextcloud container runs its PHP as):

```bash
# on TrueNAS (shell)
mkdir -p /mnt/storage1/dyingstar/nextcloud/data /mnt/storage1/dyingstar/nextcloud/backup
chown -R 33:33 /mnt/storage1/dyingstar/nextcloud
chmod -R 0770 /mnt/storage1/dyingstar/nextcloud
```

### 1.3 NFS share

TrueNAS UI → **Shares** → *UNIX (NFS) Shares* → *Add*:

| Setting | Value |
|---|---|
| Path | `/mnt/storage1/dyingstar/nextcloud` |
| Enabled | yes |
| **Networks** | the subnet of your Kubernetes nodes only, e.g. `192.168.1.0/24` — an NFS export has no authentication, the network ACL *is* the security |
| **Maproot User / Group** | `root` / `root` |
| Read Only | no |

`Maproot = root` (i.e. `no_root_squash`) is needed because kubelet touches the
export as root when it sets up the `subPath` mounts. It is only granted to the
node subnet listed above.

Then **Services → NFS**: enable NFSv4, and make sure the service is set to start
automatically.

### 1.4 Snapshots

TrueNAS UI → **Data Protection** → *Periodic Snapshot Tasks* → *Add*:

| Setting | Value |
|---|---|
| Dataset | `storage1/dyingstar/nextcloud` |
| Recursive | yes |
| Snapshot Lifetime | see below |
| Schedule | see below |

A reasonable ladder for an asset library:

| Schedule | Keep |
|---|---|
| Daily, `30 2 * * *` | 2 weeks |
| Weekly, Sunday `0 3` | 8 weeks |
| Monthly, 1st `0 4` | 12 months |

#### Why the daily snapshot must run *after* the database dump

The dataset holds both halves of a restore:

```
/mnt/storage1/dyingstar/nextcloud/
├── data/     ← the .blend files, mounted into Nextcloud
└── backup/   ← the pg_dump files, written by this chart's CronJob
```

A ZFS snapshot freezes the *whole dataset* at one instant, so a single snapshot
captures the files and the database together — that is what makes it a coherent
restore point. But only if the dump is already on disk when the snapshot fires:

```
02:15  CronJob nextcloud-db-backup  → writes backup/nextcloud-….sql.gz
02:30  TrueNAS periodic snapshot    → freezes data/ + backup/ together   ✅
```

The dump is **not** a TrueNAS task: it is the `nextcloud-db-backup` CronJob
shipped by this chart, on by default. There is nothing to create on the NAS —
only the snapshot tasks.

Both clocks must agree. A Kubernetes CronJob runs on the controller-manager's
clock, which is UTC; TrueNAS snapshot tasks run on the NAS's local clock. The
chart therefore pins `dbBackup.timeZone` (default `Europe/Paris`) — set it to
whatever the TrueNAS box is on, otherwise 02:15 here is not 02:15 there and the
ordering silently inverts.

Any snapshot that fires between midnight and `dbBackup.schedule` carries the
*previous* day's dump — so give the weekly and monthly tasks a time later in the
morning too (`0 3` and `0 4` in the table above), not `0 0`.

Reverse the two (snapshot at 02:00, dump at 02:15) and tonight's snapshot carries
*yesterday's* dump: 24 h of drift between the files and the database. Restoring
from it gives you a Nextcloud whose database has never heard of a day's worth of
uploads, plus shares, versions and permissions that are a day stale.

The hourly snapshots carry no fresh dump, and that is fine — they cover "I
overwrote a .blend an hour ago", where you pull the single file back out of the
snapshot without touching the database. The daily one is the real restore point.

#### Why a snapshot is not yet a backup

A ZFS snapshot is not a copy: it is a frozen view living **in the same pool, on
the same disks**. It protects you from an accidental delete, an overwrite, or
ransomware on someone's workstation. It does not protect you from losing the pool
— several disks, the controller, the PSU, a fire, a theft. If the pool goes, the
snapshots go with it.

If you have a second box, add a **Replication Task** (`zfs send`/`receive` to
another pool or machine). That one is an actual second copy.

### 1.5 Node prerequisite

Every Kubernetes node must be able to mount NFS:

```bash
# Debian/Ubuntu
apt-get install -y nfs-common
# RHEL/Fedora
dnf install -y nfs-utils
```

Verify from a node before deploying:

```bash
mount -t nfs4 -o nfsvers=4.1 192.168.1.10:/mnt/storage1/dyingstar/nextcloud /mnt/test
```

---

## 2. Authentication (GitHub → Keycloak → Nextcloud)

Login chain: the user clicks **GitHub** on the Nextcloud login page → Nextcloud
redirects to Keycloak (`dyingstar-studio` realm) → Keycloak redirects to GitHub →
back through Keycloak, which issues an `id_token` carrying a `groups` claim →
`user_oidc` creates/updates the Nextcloud account and its group membership.

Write access is therefore **membership of the `ds-modelers` Keycloak group**, and
nothing else. Adding or removing a modeler is one click in Keycloak.

> Nextcloud does not exist yet at this point, and nothing in this section talks
> to it — the redirect URLs you register here simply have to match the hostname
> Nextcloud will answer on later. Handing out write access is the one part that
> needs a running Nextcloud, so it lives in §7.1.

### 2.1 GitHub OAuth App

<https://github.com/settings/developers> → **OAuth Apps** → *New OAuth App* (or,
better, in the **DyingStar organisation** settings so it is not tied to a
personal account):

| Field | Value |
|---|---|
| Application name | `DyingStar Cloud` |
| Homepage URL | `https://cloud.dev.dyingstar-game.space` |
| Authorization callback URL *(a.k.a. Redirect URI)* | `https://auth.dev.dyingstar-game.space/realms/dyingstar-studio/broker/github/endpoint` |

Keep the **Client ID** and generate a **Client Secret**.

Two things worth checking:

- If the form also asks for *Permissions*, a *Webhook URL* or a private key, you
  are on the **GitHub App** form, not the OAuth App one. Keycloak's built-in
  `github` identity provider expects an OAuth App.
- Keycloak's identity provider screen shows a read-only *Redirect URI* of its
  own. That is the value to copy **into** GitHub — it must be byte-identical to
  the callback URL above.

### 2.2 Deploy Keycloak into `dyingstar-dev-shared`

This namespace gets its own Keycloak, from the repo's existing
[`keycloak/`](../keycloak) chart with a dedicated overlay — upstream image, no
realm import, no Discord IdP:

```bash
NS=dyingstar-dev-shared
KC=--context=dyingstar

kubectl $KC -n $NS create secret generic keycloak-admin \
  --from-literal=KEYCLOAK_ADMIN=admin \
  --from-literal=KEYCLOAK_ADMIN_PASSWORD="$(openssl rand -base64 24)"

kubectl $KC -n $NS create secret generic keycloak-db \
  --from-literal=password="$(openssl rand -base64 24)"

helm upgrade --install --kube-context=dyingstar -n $NS \
  keycloak ./keycloak -f keycloak/values-dev-shared.yaml

kubectl $KC -n $NS rollout status deploy/keycloak --timeout=10m
```

> The release must be named `keycloak`: `keycloak/values-dev-shared.yaml`
> references the `keycloak-admin` and `keycloak-db` Secrets by name.
>
> The database password lives in `keycloak-db`, not in a chart value, and must
> **never be regenerated** afterwards. PostgreSQL only applies
> `POSTGRES_PASSWORD` during the initial `initdb`: once the PVC holds a database,
> a new value reaches Keycloak but never PostgreSQL, and Keycloak fails to start
> with `FATAL: password authentication failed for user "keycloak"`. See §8 for
> the recovery.

**Upgrading a `keycloak` release created before the selector fix.** The chart used
to select its server pods on `app.kubernetes.io/name` + `instance` alone — labels
the bundled PostgreSQL and the Discord bootstrap Job also carry. The Service
therefore load-balanced part of the HTTP traffic onto PostgreSQL, and
`kubectl exec deploy/keycloak` could land in the wrong container. The fix adds
`app.kubernetes.io/component: server`, and a Deployment's `spec.selector` is
immutable, so the Deployment has to be recreated once:

```bash
kubectl $KC -n $NS delete deploy keycloak
helm upgrade --install --kube-context=dyingstar -n $NS \
  keycloak ./keycloak -f keycloak/values-dev-shared.yaml \
  --set postgresql.auth.password=<the same password as before>
```

The database is untouched (separate Deployment, separate PVC). The same one-off
recreate applies to the `dyingstar-prod`, `dyingstar-preprod` and `dyingstar`
releases of this chart, each with its own values file.

Read the admin password back with:

```bash
kubectl $KC -n $NS get secret keycloak-admin -o jsonpath='{.data.KEYCLOAK_ADMIN_PASSWORD}' | base64 -d; echo
```

### 2.3 Configure the realm

The scripted way — creates the realm, the `nextcloud` client, the `groups` client
scope and its Group Membership mapper, both groups, and the GitHub IdP:

```bash
GITHUB_CLIENT_ID=<oauth-app-client-id> \
GITHUB_CLIENT_SECRET=<oauth-app-client-secret> \
./nextcloud/scripts/bootstrap-keycloak.sh
```

It targets `deploy/keycloak` in `dyingstar-dev-shared` by default. It is idempotent — re-run it whenever a value changes. It prints the generated
client secret and the exact `kubectl create secret` line for the next step, so
**keep that output**.

<details>
<summary>The same thing by hand, in the admin console</summary>

1. **Create realm** `dyingstar-studio`. Turn *User registration* off.
2. **Client scopes → Create**: name `groups`, protocol `openid-connect`,
   *Include in token scope* on. Inside it, **Mappers → Configure a new mapper →
   Group Membership**: Name `groups`, Token Claim Name `groups`,
   **Full group path OFF**, add to ID token / access token / userinfo.
3. **Clients → Create client** `nextcloud`:
   - Client authentication **On** (confidential), Standard flow only.
   - Valid redirect URIs:
     `https://cloud.dev.dyingstar-game.space/apps/user_oidc/code` and
     `https://cloud.dev.dyingstar-game.space/index.php/apps/user_oidc/code`
   - Web origins: `https://cloud.dev.dyingstar-game.space`
   - **Client scopes → Add client scope → `groups` → Default**
   - **Credentials** tab: copy the client secret.
4. **Groups → Create**: `ds-modelers` and `ds-viewers`.
5. **Realm settings → User registration → Default groups**: add `ds-viewers`, so
   every new GitHub user gets read access and write stays an explicit promotion.
6. **Identity providers → GitHub**: paste the GitHub client id/secret, *Trust
   Email* on. Copy the *Redirect URI* Keycloak shows and check it matches what
   you registered on GitHub.

</details>

### 2.4 Nextcloud side

Nothing to do by hand: the chart's `before-starting` hook installs and enables
`user_oidc`, registers the provider, and turns on group provisioning on every pod
start. See §4.

---

## 3. Traefik and DNS

Both gateway listeners are already declared in
[`traefik/values-preprod.yaml`](../traefik/values-preprod.yaml), the same way
`harbor` and `grafana` are:

| Listener | Hostname | Certificate |
|---|---|---|
| `nextcloud` | `cloud.dev.dyingstar-game.space` | `nextcloud-tls` |
| `keycloakdev` | `auth.dev.dyingstar-game.space` | `keycloak-dev-tls` |

`keycloakdev` is a distinct listener from the existing `keycloak` one, which
fronts the *preprod player* realm at `auth-preprod.dyingstar-game.com`.

Sync the Traefik ArgoCD app so both listeners exist **before** installing the
charts, otherwise their HTTPRoutes have no parent to attach to.

cert-manager's gateway-shim issues both certificates into the **`traefik`**
namespace (the Gateway's namespace), not into `dyingstar-dev-shared`.

Add the DNS records — both must resolve before cert-manager can pass the HTTP-01
challenge:

```
cloud.dev.dyingstar-game.space.  A  <cluster ingress IP>
auth.dev.dyingstar-game.space.   A  <cluster ingress IP>
```

---

## 4. Install

The namespace already runs the `dev-services` release (PostGIS, chart
[`dev-services/`](../dev-services)). Nothing here touches it — the names are all
prefixed `nextcloud-` or `keycloak-`.

### 4.1 Secrets

Nothing secret is committed; `values-dev-shared.yaml` only references these.
`keycloak-admin` was already created in §2.2.

```bash
NS=dyingstar-dev-shared
KC=--context=dyingstar

kubectl $KC create namespace $NS --dry-run=client -o yaml | kubectl $KC apply -f -

# Nextcloud local admin (the break-glass account; everyone else logs in via GitHub)
kubectl $KC -n $NS create secret generic nextcloud-admin \
  --from-literal=nextcloud-username=admin \
  --from-literal=nextcloud-password="$(openssl rand -base64 24)"

kubectl $KC -n $NS create secret generic nextcloud-postgresql \
  --from-literal=db-username=nextcloud \
  --from-literal=db-database=nextcloud \
  --from-literal=db-password="$(openssl rand -base64 24)"

kubectl $KC -n $NS create secret generic nextcloud-redis \
  --from-literal=redis-password="$(openssl rand -base64 24)"

# From the output of bootstrap-keycloak.sh
kubectl $KC -n $NS create secret generic nextcloud-oidc \
  --from-literal=client-id='nextcloud' \
  --from-literal=client-secret='<printed by the script>' \
  --from-literal=discovery-uri='https://auth.dev.dyingstar-game.space/realms/dyingstar-studio/.well-known/openid-configuration'
```

Read the admin password back with:

```bash
kubectl $KC -n $NS get secret nextcloud-admin -o jsonpath='{.data.nextcloud-password}' | base64 -d; echo
```

### 4.2 Fill in the TrueNAS coordinates

Edit [`values-dev-shared.yaml`](values-dev-shared.yaml):

```yaml
truenas:
  server: "192.168.1.10"                        # ⚠ your TrueNAS address
  path: "/mnt/storage1/dyingstar/nextcloud"         # ⚠ your dataset export path
```

### 4.3 Deploy

```bash
helm dependency update ./nextcloud

helm upgrade --install --kube-context=dyingstar -n dyingstar-dev-shared \
  nextcloud ./nextcloud -f nextcloud/values-dev-shared.yaml --create-namespace
```

> The release **must** be named `nextcloud`. A handful of resource names
> (`nextcloud-postgresql`, `nextcloud-redis`, `nextcloud-oidc`,
> `nextcloud-bootstrap`, `nextcloud-data`) are referenced literally in the
> subchart values, because Helm cannot template values passed to a subchart.

First start runs the schema migration and installs two apps from the app store —
allow a few minutes:

```bash
kubectl --context=dyingstar -n dyingstar-dev-shared rollout status deploy/nextcloud --timeout=15m
kubectl --context=dyingstar -n dyingstar-dev-shared logs deploy/nextcloud -c nextcloud | grep '\[dyingstar\]'
```

Every `[dyingstar]` line should be free of `FAILED`.

### 4.4 Verify

```bash
NC="kubectl --context=dyingstar -n dyingstar-dev-shared exec deploy/nextcloud -c nextcloud --"

$NC php occ status
$NC php occ user_oidc:provider          # the keycloak provider must be listed
$NC php occ groupfolders:list           # 3D-Assets, with ds-modelers / ds-viewers
$NC php occ config:system:get memcache.locking   # \OC\Memcache\Redis
```

---

## 5. Public read-only access

Nextcloud has no `occ` command to create a share link, so this is the one step
that stays manual — two clicks, once:

1. Log in as `admin` (local account, not the GitHub button).
2. Open **Files → 3D-Assets**.
3. **Share → Share link → +**, then in the link's settings choose
   **Read only**, and leave *Hide download* off.
4. Publish the resulting `https://cloud.dev.dyingstar-game.space/s/xxxxxxxx` URL.

Anyone with that link can browse and download without an account. `.blend` files
have no preview handler, which is fine — the download is what matters.

Authenticated GitHub users additionally get the folder mounted in their own
Files view (read-only for `ds-viewers`, read-write for `ds-modelers`), which is
what makes the desktop sync client and WebDAV usable:

```
https://cloud.dev.dyingstar-game.space/remote.php/dav/files/<user>/
```

> If you would rather the library not be reachable anonymously at all, skip this
> section: `ds-viewers` (the Keycloak realm default group) already gives every
> GitHub user read access.

---

## 6. Backup and restore

Two layers, and they only work together:

- **Files** — ZFS snapshots of the dataset, on TrueNAS (§1.4).
- **Database** — the `nextcloud-db-backup` CronJob writes a compressed `pg_dump`
  to `<dataset>/backup/` every night at 02:15, keeping 14 days. Because it lands
  *on the same dataset*, each ZFS snapshot is a self-contained restore point.

A snapshot of the files alone is not a backup: without the matching database,
Nextcloud does not know the files exist.

Check the dumps:

```bash
kubectl --context=dyingstar -n dyingstar-dev-shared create job --from=cronjob/nextcloud-db-backup manual-dump-1
kubectl --context=dyingstar -n dyingstar-dev-shared logs job/manual-dump-1
```

### Restoring

```bash
NS=dyingstar-dev-shared; KC=--context=dyingstar

# 1. Freeze Nextcloud
kubectl $KC -n $NS exec deploy/nextcloud -c nextcloud -- php occ maintenance:mode --on

# 2. Roll the dataset back to the snapshot, on TrueNAS
#    (Datasets > Snapshots > the one you want > Rollback)

# 3. Restore the database dump taken in that same snapshot
kubectl $KC -n $NS exec -i deploy/nextcloud-postgresql -- \
  sh -c 'gunzip -c | psql -U nextcloud -d nextcloud' < nextcloud-20260904T021500Z.sql.gz

# 4. Thaw, and let Nextcloud re-index anything that moved
kubectl $KC -n $NS exec deploy/nextcloud -c nextcloud -- php occ maintenance:mode --off
kubectl $KC -n $NS exec deploy/nextcloud -c nextcloud -- php occ files:scan --all
```

The `.sql.gz` files sit in `<dataset>/backup/` — read them straight off TrueNAS.

---

## 7. Day-to-day

```bash
NS=dyingstar-dev-shared; KC=--context=dyingstar
NC="kubectl $KC -n $NS exec deploy/nextcloud -c nextcloud --"

# Re-apply the chart's configuration (the hook runs on every start, idempotently)
kubectl $KC -n $NS rollout restart deploy/nextcloud

# Who has write access, as Nextcloud sees it
$NC php occ group:list

# Files added outside Nextcloud (copied onto the NFS share directly) need a scan
$NC php occ files:scan --all

# Health / warnings shown in the admin overview
$NC php occ status
```

Changing `groupFolder.*`, `tuning.*` or `oidc.*` is a `helm upgrade` followed by
a pod restart — the hook re-applies everything.

### 7.1 Granting write access to someone

1. The person logs in once at <https://cloud.dev.dyingstar-game.space> with GitHub —
   this creates their Keycloak and Nextcloud accounts.
2. Keycloak → `dyingstar-studio` → **Groups → ds-modelers → Members → Add member**.
3. They log out and back in. The new `groups` claim promotes them in Nextcloud.

Removing write access is the same in reverse; the change takes effect at their
next login.

---

## 8. Troubleshooting

Commands below reuse the two shell variables used throughout this document:

```bash
NS=dyingstar-dev-shared
KC=--context=dyingstar
```

| Symptom | Cause / fix |
|---|---|
| Pod stuck `ContainerCreating`, event `mount.nfs: access denied` | The node IP is not in the NFS share's *Networks* list, or `nfs-common` is missing on the node. |
| Pod stuck `ContainerCreating`, event about `subPath` | `data/` or `backup/` does not exist on the dataset, and *Maproot User* is not `root` so kubelet cannot create them. See §1.2 / §1.3. |
| PostgreSQL `CrashLoopBackOff`, logs say `PANIC: could not locate a valid checkpoint record` | Two `postgres` processes wrote the same data directory. The Deployment used the default `RollingUpdate`, which starts the new pod before stopping the old one; on a single-node cluster both mount the same ReadWriteOnce PVC. Fixed in the charts (`strategy: Recreate`) — the corrupted volume still has to be discarded, see below. |
| Keycloak `CrashLoopBackOff`, logs say `FATAL: password authentication failed for user "keycloak"` | The `keycloak-db` Secret and the database itself disagree — the password was regenerated after the PVC was initialised. Realign them, see below. |
| `bootstrap-keycloak.sh`: `/opt/keycloak/bin/kcadm.sh: No such file or directory` | The command landed in the PostgreSQL pod. Recreate the `keycloak` Deployment so its pods carry `app.kubernetes.io/component: server` — see §2.2. |
| `[dyingstar] app user_oidc: INSTALL FAILED` | The pod has no egress to `apps.nextcloud.com`. Fix egress, then `kubectl $KC -n $NS rollout restart deploy/nextcloud`. |
| GitHub button missing on the login page | `user_oidc` is not enabled or the provider was not registered — check the `[dyingstar]` log lines, then `occ user_oidc:provider`. |
| Users log in but land in no group | The `groups` claim is missing. In Keycloak, check the `groups` client scope is a **Default** scope of the `nextcloud` client and that *Full group path* is **off** on the mapper. Inspect the token in Keycloak's *Client scopes → Evaluate* tab. |
| Group names in Nextcloud are prefixed | Some `user_oidc` versions namespace provisioned groups by provider. Run `occ group:list`, then point `groupFolder.writeGroup`/`readGroup` at the real names and `helm upgrade`. |
| `user_oidc:provider FAILED` in the logs | Option names drift between `user_oidc` releases. Run `$NC php occ user_oidc:provider --help` and adjust the hook in `values.yaml`. |
| Large uploads fail around 1 GB | `APACHE_BODY_LIMIT` / `PHP_UPLOAD_LIMIT` did not take effect — check them with `$NC env | grep -E 'APACHE_BODY|PHP_UPLOAD'`. |
| Uploads time out on slow links | Traefik's `idleTimeout` is 3600s in `traefik/values-preprod.yaml`; raise it there if needed. |
| "Transactional file locking should be configured" warning | Redis is down. `kubectl $KC -n $NS logs deploy/nextcloud-redis`. |
| TLS certificate never issued | The gateway listener is missing or the DNS record does not resolve yet. `kubectl $KC -n traefik get gateway traefik-gateway -o yaml` and `kubectl $KC -n traefik get certificate`. |

### Rebuilding a corrupted Keycloak database

Only for a Keycloak whose realms have not been created yet — this discards the
database. If it already holds realms, restore a dump instead.

```bash
NS=dyingstar-dev-shared; KC=--context=dyingstar

# 1. Stop everything that mounts the volume
kubectl $KC -n $NS scale deploy keycloak keycloak-postgresql --replicas=0

# 2. Drop any orphaned ReplicaSet left behind by an earlier Deployment recreate
kubectl $KC -n $NS get rs -l app.kubernetes.io/name=keycloak

# 3. Discard the corrupted volume
kubectl $KC -n $NS delete pvc keycloak-postgresql

# 4. Redeploy. initdb runs again and takes its password from the keycloak-db
#    Secret, so both sides agree from the start.
helm upgrade --install --kube-context=dyingstar -n $NS \
  keycloak ./keycloak -f keycloak/values-dev-shared.yaml

kubectl $KC -n $NS rollout status deploy/keycloak --timeout=10m
```

### Realigning the Keycloak database password

PostgreSQL keeps the password it was initialised with; the Secret can drift away
from it. Pick one value and set it on both sides:

```bash
NS=dyingstar-dev-shared; KC=--context=dyingstar
PW=$(openssl rand -base64 24)

# 1. The database. Local socket connections inside the container are trusted,
#    so no current password is needed.
kubectl $KC -n $NS exec -i deploy/keycloak-postgresql -- \
  psql -U keycloak -d keycloak <<EOF
ALTER USER keycloak WITH PASSWORD '$PW';
EOF

# 2. The Secret Keycloak reads.
kubectl $KC -n $NS create secret generic keycloak-db \
  --from-literal=password="$PW" --dry-run=client -o yaml | kubectl $KC -n $NS apply -f -

# 3. Restart Keycloak.
kubectl $KC -n $NS rollout restart deploy/keycloak
kubectl $KC -n $NS rollout status deploy/keycloak --timeout=10m
```

Keycloak's own data is untouched — only the role's password changes.

---

## 9. Alternatives considered

- **democratic-csi / csi-driver-nfs** — dynamic provisioning against the TrueNAS
  API, one ZFS dataset per PVC, and Kubernetes `VolumeSnapshot` support. Worth it
  if you end up with many volumes on TrueNAS; overkill for one. To switch: set
  `truenas.createPV: false` and `truenas.storageClassName` to the CSI class — the
  PVC name (`nextcloud-data`) and everything downstream stay identical.
- **S3 primary storage** — Nextcloud can put its primary storage in an object
  store, but the files then live as opaque object ids: you lose the ability to
  browse or restore a single `.blend` from a ZFS snapshot, which is precisely the
  property you asked for.
- **The `sociallogin` app talking to GitHub directly** — removes the Keycloak
  hop, but it is a third-party app and it gives no group information, so "write
  access for a named list" would become manual per-user administration inside
  Nextcloud.
