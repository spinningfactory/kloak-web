# Security Model

This page describes Kloak's trust chain, the threat model it is designed to address, and the known limitations of the system.

## Threat Model

Kloak is designed to protect Kubernetes secrets against the following threats:

### In-Scope Threats

**Application memory compromise** -- An attacker gains the ability to read arbitrary memory in an application container (e.g., via a heap dump, core dump, `/proc/<pid>/mem`, or memory-disclosure vulnerability). Without Kloak, the real secret values are in memory (from mounted secret volumes or environment variables). With Kloak, the application only ever sees `kloak:<ULID>` placeholders -- the real values are never loaded into user-space memory.

**Container escape to application namespace** -- An attacker who escapes to the node filesystem within the application namespace cannot recover real secrets. The shadow secret files contain only ULID placeholders. The real values exist only in the controller's process memory (in `kloak-system`) and in kernel-space BPF maps.

**Secret exfiltration via SSRF** -- An attacker exploits a server-side request forgery vulnerability to make the application send HTTP requests to an attacker-controlled server. Without host filtering, the TLS connection to the attacker's server would carry the real secret. With `getkloak.io/hosts` configured, Kloak's eBPF program checks the destination hostname before rewriting -- connections to unauthorized hosts receive the harmless ULID placeholder.

**Accidental secret leakage** -- Secrets accidentally logged, serialized to JSON, sent in error reports, or included in stack traces are harmless ULID values. The real value is only present in the kernel-encrypted TLS stream to the intended destination.

### Out-of-Scope Threats

**Node-level compromise with root access** -- An attacker with root access on the worker node can read BPF maps (`bpftool map dump`), attach to the controller process, or modify eBPF programs. Kloak does not protect against a root-level node compromise. The controller itself requires root privileges, so the trust boundary is at the node level.

**Compromise of `kloak-system` namespace** -- An attacker who can create or modify resources in the `kloak-system` namespace can access the controller's in-memory secret store or modify the webhook behavior. This namespace must be restricted to cluster administrators only.

**Kubernetes API access to secrets** -- An attacker with `get` or `list` permissions on Secrets in the application namespace can still read the original secret (not the shadow). Kloak does not replace Kubernetes RBAC -- it complements it by protecting secrets in the runtime layer.

**Non-TLS exfiltration** -- If an application sends secrets over plaintext HTTP, raw TCP, or UDP, Kloak cannot intercept or rewrite the data. Kloak operates on TLS write functions (`SSL_write`, `crypto/tls.Write`). Network policies should be used to restrict non-TLS egress.

**Denial of service** -- An attacker who can crash the controller DaemonSet or delete the webhook deployment can prevent new pods from being mutated. Existing pods with already-attached uprobes continue to work (BPF maps persist), but new pods will mount original secrets.

## Trust Chain

Kloak's security relies on a chain of trust with several links. Each link is described below along with what breaks if that link is compromised.

### 1. Kubernetes API Server

The API server is the root of trust. The SecretReconciler reads secrets via the API, and the webhook receives admission requests from it.

**If compromised:** An attacker could modify secrets, bypass the webhook, or inject pods without mutation. This is equivalent to cluster-level compromise.

### 2. Webhook Admission

The mutating webhook intercepts pod creation and rewrites secret volume references to point to shadow secrets. The API server verifies the webhook's TLS certificate via the `caBundle`.

**If bypassed:** Pods would mount original secrets instead of shadow secrets. eBPF interception still applies if the controller attaches uprobes, but the application would have real secrets in memory.

### 3. Controller DaemonSet

The controller creates shadow secrets, stores real-to-shadow mappings, syncs them to BPF maps, and attaches uprobes and TC egress programs to containers.

**If compromised:** An attacker could read real secrets from the in-memory store, modify BPF maps to inject arbitrary values, or disable uprobe attachment.

### 4. eBPF Programs (Kernel)

The BPF programs are loaded by the controller and run in kernel context. They are verified by the kernel BPF verifier and cannot be modified by user-space processes without `CAP_BPF` + `CAP_SYS_ADMIN`.

**If tampered with:** An attacker could disable rewriting, redirect secrets to unauthorized hosts, or exfiltrate secrets. Requires root on the node.

### 5. DNS Resolution

Host filtering depends on the integrity of DNS responses. Kloak captures DNS responses via a kprobe on `udp_recvmsg` and validates the source IP against a whitelist of trusted DNS servers (auto-discovered from `kube-dns` or user-configured).

**If poisoned:** An attacker who can spoof DNS responses from a trusted server IP could trick Kloak into associating an attacker-controlled IP with an allowed hostname. The eBPF program would then rewrite secrets for connections to that IP.

**Mitigations:**
- Trusted DNS server whitelist limits which source IPs are accepted
- DNS entries include TTL enforcement -- expired entries are rejected
- In-cluster DNS (CoreDNS/kube-dns) is typically not accessible to application pods for spoofing
- DNSSEC or encrypted DNS (DoH/DoT) at the cluster level further reduces risk

### 6. TLS Library Integrity

Kloak attaches uprobes to specific TLS library functions. If the application's TLS library is replaced or modified, uprobes may not attach correctly or may fire on different functions.

**If tampered with:** A modified TLS library could bypass the uprobe attachment point, causing secrets to not be rewritten. This is fail-secure -- the placeholder is sent instead of the real secret.

## How the Pieces Fit Together

```
Kubernetes API (root of trust)
  │
  ├── Webhook (admission control)
  │     └── Rewrites secret volumes → shadow secrets
  │
  ├── SecretReconciler (control plane)
  │     ├── Creates shadow secrets with ULID placeholders
  │     └── Stores real values in controller memory
  │
  ├── Controller (per-node)
  │     ├── Syncs real values to BPF maps (kernel memory)
  │     ├── Attaches uprobes to TLS write functions
  │     ├── Attaches TC egress to container interfaces
  │     └── Discovers trusted DNS servers
  │
  └── eBPF Programs (kernel)
        ├── Uprobe: scan for placeholders, compute XOR delta
        ├── DNS kprobe: validate responses from trusted servers
        ├── Connect tracepoint: track fd → IP mappings
        └── TC egress: patch ciphertext, recompute GHASH tag
```

## Fail Modes

Kloak is designed to **fail secure** -- if any component fails, the application sends the harmless ULID placeholder instead of the real secret.

| Failure | Impact |
|---|---|
| Controller down | New pods are not mutated (if webhook also down) or mount shadow secrets but uprobes not attached. Existing pods with attached uprobes continue working. |
| Webhook down | New pods mount original secrets (no mutation). failurePolicy: Fail blocks pod creation by default. |
| Uprobe attachment fails | Application sends `kloak:<ULID>` placeholder to the remote server. Request fails at the API level (invalid credential). |
| H extraction fails | XOR-patch path unavailable. Go plaintext path used as fallback for Go apps. OpenSSL apps send placeholder. |
| DNS resolution missing | Host cannot be verified. eBPF program does not rewrite -- placeholder sent. |
| BPF map full | New entries rejected. Existing secrets continue working. New secrets send placeholder. |
| TC egress not attached | XOR delta computed but not applied. Ciphertext contains shadow value. |

## Known Limitations

### Secret Size

The maximum secret value that can be rewritten is **128 bytes** (`SECRET_MAX_LEN`). Secrets longer than 128 bytes are truncated in the BPF map. This limit exists to stay within eBPF program memory and verification constraints. It covers most API keys, tokens, and passwords, but not large certificates or multi-line secrets.

### Secrets Per TLS Write

The eBPF program can detect and rewrite up to **4 secrets per `SSL_write` call** (`XOR_MAX_MATCHES`). If a single TLS write buffer contains more than 4 `kloak:` placeholders, only the first 4 are rewritten. This limit exists to stay within eBPF program complexity and verification constraints.

### Hostname Length

Hostnames for host filtering are limited to **64 characters** (`MAX_HOST_LEN`). Hostnames longer than 64 characters are truncated. This limit exists to keep BPF map entries within eBPF memory constraints. It covers the vast majority of real-world API endpoints.

### OpenSSL Version Coverage

The XOR-patch path requires version-specific struct offsets for extracting the GHASH key. Currently supported: **OpenSSL 3.2 -- 3.5**. OpenSSL 3.0/3.1 use a different struct layout (3-hop vs 4-hop chain) and are not yet supported. See [Supported Runtimes](/guides/supported-runtimes) for details.
