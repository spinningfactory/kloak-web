# Architecture Overview

Kloak is a Kubernetes-native secret protection system that uses eBPF to rewrite secret placeholders with real values at the kernel level, after TLS encryption. Applications never see actual secrets -- they work with harmless ULID placeholders that are transparently substituted in the encrypted output.

## Components

Kloak consists of three main components deployed in the `kloak-system` namespace:

### Controller (DaemonSet)

The controller runs as a **DaemonSet** -- one pod per node -- because eBPF programs must be loaded on the same kernel where the target processes run.

It performs four functions:

1. **SecretReconciler** -- Watches Kubernetes Secrets labeled `getkloak.io/enabled=true`. For each enabled secret, creates a shadow secret (`<name>-kloak`) containing length-matched `kloak:<ULID>` placeholders. Stores the ULID-to-real-value mappings with allowed host and port metadata in an in-memory store.

2. **Pod Reconciler** -- Watches Pods annotated `getkloak.io/enabled=true` on the local node. When a matching pod is detected, resolves each container's cgroup ID, then delegates to the TLS Uprobe Manager. Failed attachments are retried every 500ms (handles runtimes like Python where `libssl` loads lazily).

3. **TLS Uprobe Manager** -- Loads eBPF programs into the kernel, attaches uprobes to each container process's TLS write functions, attaches TC egress programs to container network interfaces, syncs the secret map to BPF every 5 seconds, and polls the ring buffer for rewrite events. Also tracks process lifecycle (exec/exit) in tracked cgroups to attach uprobes to newly spawned processes.

4. **Trusted DNS Discovery** -- Auto-discovers the `kube-dns` ClusterIP from the `kube-system/kube-dns` service and populates the `trusted_dns_servers` BPF map. Only DNS responses from trusted servers are used for host filtering. Additional servers can be configured via the `--trusted-dns-servers` flag.

### Webhook (Deployment)

The webhook runs as a standard **Deployment** (typically 1 replica). It is a Kubernetes mutating admission webhook registered for `CREATE` operations on pods.

Two `MutatingWebhookConfiguration` entries ensure only kloak-enabled workloads are sent to the webhook:
- **Namespace-scoped:** matches namespaces labeled `getkloak.io/enabled=true`
- **Pod-scoped:** matches pods labeled `getkloak.io/enabled=true` via `objectSelector`

Non-kloak workloads are never affected, even if the webhook is down.

When a pod is matched:

1. Checks if Kloak is enabled for this pod (pod label or namespace label)
2. Scans all Secret-backed volumes in the pod spec
3. For each volume referencing a secret that has a shadow copy, rewrites `secretName` from `original` to `original-kloak`
4. **Rejects** the pod if any kloak-enabled secret's shadow does not exist yet (fail-closed)
5. Adds `getkloak.io/enabled: "true"` annotation to the pod so the controller knows to attach eBPF uprobes

### eBPF Programs

The eBPF programs run in-kernel and are loaded by the controller. The secret rewriting pipeline has three stages:

#### Stage 1: Uprobe -- Scan and Compute

When `SSL_write` or `crypto/tls.(*Conn).Write` is called, the uprobe fires and:

1. Reads the plaintext write buffer (up to 256 bytes per chunk, scanning the full buffer via `bpf_loop`)
2. Pre-scans for `kloak:` prefixes (8-byte key match), finding up to 4 matches per call
3. For each match, looks up the real secret value in the `secret_map` BPF hash map
4. Resolves the destination hostname via the DNS trust chain (see below)
5. Checks the resolved hostname and port against the secret's allowed host/port
6. Computes XOR deltas: `xor_delta[i] = shadow_byte[i] ^ real_byte[i]` for each matched secret
7. Stores the pending patches in `xor_pending` (keyed by thread ID)

The uprobe also extracts the GHASH key H from the TLS connection's internal structures on first write. For OpenSSL 3.2+, this follows a 4-hop pointer chain through the SSL struct. For Go `crypto/tls`, it reads H*2 from the GCM productTable and applies GF(2^128) halving.

#### Stage 2: Kprobe -- Bridge to Network

A kprobe on `tcp_sendmsg` fires when the TLS library sends the encrypted data:

1. Reads the pending patches from `xor_pending`
2. Extracts the source port from the socket
3. Builds a `tc_pending` entry keyed by `(destination IP, source port, cgroup ID)`
4. The patches are now ready for the TC egress program

#### Stage 3: TC Egress -- Patch Ciphertext

A TC (traffic control) egress program attached to the container's network interfaces (`eth0` and `lo`) intercepts outbound packets:

1. Looks up `tc_pending` by matching the packet's destination IP, source port, and cgroup
2. For each patch, XORs the corresponding ciphertext bytes: `CT_real = CT_shadow XOR xor_delta`
3. Recomputes the GHASH authentication tag using precomputed H powers (GF(2^128) multiplication)
4. Patches the authentication tag in the TLS record
5. The packet leaves the node with the real secret encrypted -- no user-space memory ever held the real value

::: tip Why XOR patching works
AES-GCM in counter mode (CTR) encrypts via `ciphertext = plaintext XOR keystream`. If you know the XOR difference between the shadow and real values, you can patch the ciphertext directly: `CT_real = CT_shadow XOR (shadow XOR real)`. The keystream cancels out. The GHASH tag must be recomputed because the ciphertext changed.
:::

#### Go Plaintext Path

For Go `crypto/tls`, an alternative path writes the real secret directly into the user-space buffer before encryption (tail-call index 3). This is used when the XOR-patch path is not available (e.g., GHASH H extraction failed).

#### DNS-Verified Host Resolution

Additional eBPF programs build a chain of trust from DNS resolution to TLS write:

- **DNS Kprobe** (`udp_recvmsg`) -- Intercepts DNS responses on the node. Validates the source against the `trusted_dns_servers` whitelist. For hostnames in the `watched_hosts` set, stores resolved A/AAAA records in `dns_ip_map` with TTL.
- **Connect Tracepoints** (`sys_enter/exit_connect`) -- Tracks TCP connections (fd to destination IP) in `conn_ip_map`. When the destination IP exists in `dns_ip_map`, caches the fd in `last_verified_fd` for fast lookup.
- **Close Tracepoint** (`sys_enter_close`) -- Cleans up `conn_ip_map` entries when file descriptors are closed, preventing stale mappings after fd reuse.

At TLS write time, `resolve_host()` chains: `ssl_fd_map` (cache) -> `last_verified_fd` -> `conn_ip_map[{tgid, fd}]` -> `dns_ip_map[ip]` to determine the hostname.

## Admission Flow

When a secret and pod are created, the controller and webhook set up the shadow secret and mutate the pod:

```mermaid
sequenceDiagram
    participant K8s as Kubernetes API
    participant Ctrl as Controller
    participant WH as Webhook
    participant App as App Pod

    K8s->>Ctrl: Secret watch event
    Ctrl->>K8s: Create shadow secret (kloak:ULID)
    Ctrl->>Ctrl: Store ULID → real value
    K8s->>WH: Pod CREATE admission
    WH->>K8s: Mutate volumes → shadow secret
    K8s->>App: Pod starts with shadow mounted
    Ctrl->>App: Attach uprobes + TC egress
```

## Secret Rewrite Flow

When the application makes a TLS call, the eBPF pipeline rewrites the secret in the encrypted output:

```mermaid
sequenceDiagram
    participant App as App Pod
    participant UP as Uprobe
    participant TLS as TLS Library
    participant TC as TC Egress
    participant Net as Network

    App->>UP: SSL_write(kloak:ULID)
    UP->>UP: Scan buffer, lookup secret
    UP->>UP: Resolve host via DNS chain
    UP->>UP: Compute XOR delta
    UP->>TLS: Continue (encrypts shadow)
    TLS->>TC: Encrypted packet
    TC->>TC: XOR ciphertext + recompute GHASH
    TC->>Net: Real secret (encrypted)
```

## Security Model

Real secret values never enter application memory. The application only sees `kloak:<ULID>` placeholders. Real values exist in the controller's in-memory store and in kernel-space BPF maps -- both inaccessible to application containers. The XOR-patch pipeline ensures secrets are injected into ciphertext at the TC egress level, after TLS encryption, so they never pass through user-space.

For the full threat model, trust chain, fail modes, and known limitations, see the [Security Model](/architecture/security-model) page.

## BPF Map Layout

### Core Maps

| Map | Type | Key | Value | Purpose |
|---|---|---|---|---|
| `secret_map` | Hash | 8-byte prefix (`kloak:XX`) | Real value (128B) + host (64B) + port + protocol + full prefix (42B) | ULID-to-secret lookup |
| `tls_conn_state` | LRU Hash | {tgid, ssl_ptr} | GHASH H (16B) + H powers (16x16B) + cipher type | Per-connection TLS state for GHASH recomputation |
| `xor_pending` | Hash | pid_tgid | Patches (up to 4) with offset, length, XOR delta | Uprobe to kprobe bridge: pending ciphertext patches |

### DNS and Connection Tracking

| Map | Type | Key | Value | Purpose |
|---|---|---|---|---|
| `dns_ip_map` | LRU Hash | IP address (16B) | Hostname (64B) + TTL + timestamp | DNS-verified IP-to-hostname cache |
| `conn_ip_map` | LRU Hash | {tgid, fd} | IP address (16B) + port | TCP connection to destination IP |
| `last_verified_fd` | Hash | tgid | fd | Last fd whose IP matched a DNS-verified host |
| `ssl_fd_map` | LRU Hash | {tgid, ssl_ptr} | fd | SSL connection to fd cache |
| `watched_hosts` | Hash | Hostname (64B) | 1 | Set of hostnames to capture DNS for |
| `trusted_dns_servers` | Hash | IP address (16B) | 1 | Trusted DNS server whitelist |

### Process and Container Tracking

| Map | Type | Key | Value | Purpose |
|---|---|---|---|---|
| `tracked_cgroups` | Hash | cgroup inode ID | 1 | Containers with eBPF enabled |
| `tracked_tgids` | Hash | tgid | 1 | Processes opted in for DNS/connect tracking |

### Program Control

| Map | Type | Key | Value | Purpose |
|---|---|---|---|---|
| `prog_array` | ProgArray | Index 1-3 | Program FDs | Tail calls: 1=XOR patch, 2=H extract, 3=Go write path |
| `tc_prog_array` | ProgArray | Index 0 | Program FD | TC tail call: GHASH tag recomputation |
| `tls_events` | RingBuf | -- | Event struct (pid, len, is_rewritten) | Observability: rewrite events to userspace |
| `proc_events` | RingBuf | -- | Exec/exit events | Process lifecycle events for uprobe attachment |
