# System Requirements

Kloak uses eBPF uprobes, kprobes, tc and cgroup programs that require specific kernel and Kubernetes versions. This page details the minimum requirements and tested configurations.

## Kernel Requirements

### Minimum: Linux 5.17+

Kloak requires Linux kernel **5.17 or later**, for the `bpf_loop` helper used to scan the TLS write buffer for `kl::` placeholders. On older kernels the eBPF programs fail to load.

The program that patches ciphertext is attached on the host-side veth peer of each pod's egress interface, and the program that rewrites DNS answers on the pod's own interface. How they're attached depends on the kernel:

- **Linux 6.6+:** a TCX link (preferred). It is released automatically when the controller stops.
- **Linux 5.17 – 6.5:** a classic `clsact` qdisc with a direct-action `cls_bpf` filter. The controller falls back to this automatically when the kernel lacks TCX and logs `Kernel does not support TCX`. An existing `clsact` qdisc (for example one a CNI created) is reused, never deleted. Kloak's filter uses priority 1 and a fixed handle, so a restarted controller replaces its previous filter instead of adding a second one. Filters are removed when the controller shuts down cleanly; after a crash they stay until the controller re-attaches or the pod's interface is deleted, and do nothing in the meantime.

Set `controller.ebpf.tcAttachMode` (`--tc-attach-mode`) to `tcx` to require TCX, or `clsact` to always use the classic filter. The default is `auto`.

::: warning CNIs that use tc on the pod's interfaces
Kloak's tc programs share their hooks with any programs your CNI attaches there (for example Cilium on the pod's veth). Kloak attaches first (at the head of TCX, or at `cls_bpf` priority 1 on the `clsact` path), so a CNI program that redirects packets can't hide them, and its programs pass every packet on, so the CNI's programs still run.

TCX programs run before the classic `clsact` chain, and the chain only runs if they pass the packet on. On a node where the CNI attaches with TCX (Cilium on Linux 6.6+), Kloak must use TCX too: keep `tcAttachMode` at `auto`, or set `tcx`. On the `clsact` path, if the CNI also uses priority 1 with a different filter type or protocol, Kloak's attach fails and that pod's secrets are not rewritten (the controller logs the error).
:::

### Required Kernel Features

The following kernel configuration options must be enabled (they are enabled by default on major distributions):

| Config Option | Purpose |
|---|---|
| `CONFIG_BPF` | Base BPF support |
| `CONFIG_BPF_SYSCALL` | BPF system call |
| `CONFIG_BPF_JIT` | JIT compilation for BPF programs |
| `CONFIG_UPROBES` | User-space probes (uprobes/uretprobes on TLS libraries) |
| `CONFIG_KPROBES` | Kernel probes (`tcp_sendmsg` for SNI capture and patch handoff) |
| `CONFIG_TRACEPOINTS` | Tracepoints (connect/close, socket state, process exec/exit tracking) |
| `CONFIG_BPF_EVENTS` | BPF-based event tracing |
| `CONFIG_NET_CLS_BPF`, `CONFIG_NET_SCH_INGRESS` | Classic tc attachment (`clsact` + `cls_bpf`) on kernels without TCX |
| `CONFIG_NET_XGRESS` | TCX tc attachment on Linux 6.6+ (ciphertext patching, DNS rewrite) |
| `CONFIG_CGROUP_BPF` | cgroup `connect4`/`connect6` and `getpeername4`/`getpeername6` programs (virtual IP redirect) |
| `CONFIG_DEBUG_INFO_BTF` | BTF type information for CO-RE |

Verify BTF availability on a node:

```bash
ls /sys/kernel/btf/vmlinux
```

If the file exists, BTF is available and Kloak can use CO-RE (Compile Once, Run Everywhere) to adapt to the running kernel.

### cgroup v2

Nodes must use the **cgroup v2** (unified) hierarchy. The controller locates pod containers under the `kubepods` cgroup in `/sys/fs/cgroup`.

```bash
stat -fc %T /sys/fs/cgroup   # must print cgroup2fs
```

## Kubernetes Requirements

### Minimum: Kubernetes 1.28+

Kloak requires Kubernetes **1.28 or later** and **Helm 3** to install the chart.

### Container Runtime (NRI)

**containerd 2.0+** or **CRI-O 1.30+** is recommended. Both serve NRI (the Node Resource Interface) by default, at `/var/run/nri/nri.sock`. Through it, the runtime waits for Kloak to attach the DNS rewrite while it creates each pod sandbox, and a container's TLS uprobes before the container starts, so even the first request of a container gets the secret. Kloak never fails a runtime request: if it takes longer than the runtime's timeout (2 seconds by default), the runtime goes on and the controller reconnects.

On other runtimes, or with `controller.nri.enabled: false`, the controller attaches the DNS rewrite by polling pending pods and a container's uprobes once the pod's status reports it running. That leaves a short window at pod start: a DNS lookup made in it gets the host's real addresses (a connection made with them gets no host-restricted secret until the app resolves the name again), and a TLS write made in it sends the placeholder. The controller logs which way each node runs:

```bash
kubectl logs -n kloak-system -l app.kubernetes.io/component=controller | grep -i nri
```

### Virtual IP Ranges

Kloak hands out virtual IPs for host-restricted secrets from `controller.ebpf.virtualIPRange`, by default `198.18.0.0/15` and `2001:2::/48`. These ranges are reserved for benchmarking and never routed, so they are free on most clusters. They must not overlap any node address, pod CIDR, service CIDR, or route of a node. The controller checks this at startup and refuses to start otherwise; see [Virtual IP Ranges](/getting-started/configuration#virtual-ip-ranges) to change them.

### RBAC Requirements

The `kloak-controller` ServiceAccount, used by both the controller DaemonSet and the webhook Deployment, is granted the following cluster-level permissions:

```yaml
- apiGroups: [""]
  resources: ["pods"]
  verbs: ["get", "list", "watch"]
- apiGroups: [""]
  resources: ["secrets"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
- apiGroups: [""]
  resources: ["namespaces"]
  verbs: ["get", "list", "watch"]
- apiGroups: ["apps"]
  resources: ["replicasets", "deployments", "daemonsets", "statefulsets"]
  verbs: ["get", "list", "watch"]
- apiGroups: [""]
  resources: ["services"]
  verbs: ["get"]
- apiGroups: [""]
  resources: ["nodes"]
  verbs: ["list"]
- apiGroups: ["networking.k8s.io"]
  resources: ["servicecidrs"]
  verbs: ["list"]
- apiGroups: [""]
  resources: ["events"]
  verbs: ["create", "patch"]
```

Nodes and service CIDRs are listed for the virtual IP range check. A Role in `kube-system` also lets the controller watch the `kube-dns` Service and its EndpointSlices, to keep the trusted resolvers current:

```yaml
- apiGroups: [""]
  resources: ["services"]
  verbs: ["get", "list", "watch"]
- apiGroups: ["discovery.k8s.io"]
  resources: ["endpointslices"]
  verbs: ["get", "list", "watch"]
```

### Privileges

The controller DaemonSet needs host-level access:

- `privileged: true`, `runAsUser: 0`, AppArmor profile `Unconfined`
- `hostPID: true`
- Capabilities `BPF`, `NET_ADMIN`, `SYS_ADMIN`, `SYS_RESOURCE`
- A privileged init container that mounts tracefs at `/sys/kernel/tracing` (Bidirectional mount propagation)
- hostPath mounts: `/sys/fs/cgroup`, `/sys/fs/bpf`, `/sys/kernel/btf` (read-only), `/sys/kernel/tracing`, and the NRI socket directory `/var/run/nri`

Clusters that forbid privileged pods (for example, GKE Autopilot or namespaces enforcing the `restricted`/`baseline` Pod Security Standard) cannot run the controller.

### Architectures

Images and eBPF programs are built for **amd64** and **arm64**.

### Certificate Modes

The webhook needs a TLS certificate. Set `certificates.mode` in the chart values:

| Mode | Behavior |
|---|---|
| `auto` (default) | Helm generates a self-signed certificate, stores it in the `kloak-webhook-certs` Secret, and sets the webhook `caBundle`. An existing certificate is reused on upgrade. |
| `certManager` | Requires cert-manager. The chart creates a self-signed Issuer and a Certificate (stored in `kloak-webhook-certs`); cert-manager injects the CA bundle. |
| `provided` | Use your own TLS Secret (`certificates.provided.secretName`, `certKey`, `keyKey`). The chart does not set `caBundle` in this mode, so the webhook configurations must be made to trust your CA separately. |

## Supported Linux Distributions

### Tested in CI

| Distribution | Status | Notes |
|---|---|---|
| Ubuntu (GitHub `ubuntu-latest` runners) + k3s | Tested | Used in CI and nightly e2e. k3s's containerd serves NRI. The e2e suite runs on flannel (dual-stack), again with the `clsact` fallback forced, again with NRI off, and on Cilium with kube-proxy replacement (IPv4) |

### Expected to Work

Any distribution is expected to work when the node kernel is **5.17+** with BTF and cgroup v2 enabled. Kernels 6.6+ use TCX; older ones use the `clsact` fallback. For example:

| Distribution | Status | Notes |
|---|---|---|
| Ubuntu 24.04 LTS | Expected | Ships kernel 6.8 |
| Ubuntu 22.04 LTS | Expected with HWE kernel | Default kernel 5.15 is too old; use the HWE kernel |
| Amazon Linux 2023 | Expected | 6.1 kernels use the `clsact` fallback; 6.12 kernels use TCX |
| Debian 12 (Bookworm) | Expected | Kernel 6.1, uses the `clsact` fallback |
| Amazon Linux 2 | Not supported | Kernel 5.10 is older than 5.17 |
| RHEL / Rocky 9.x | Verify | Kernel reports 5.14 with backports; confirm `bpf_loop` is available before use |

::: warning
**Ubuntu 22.04 default kernel (5.15) is NOT compatible.** Install the HWE (Hardware Enablement) kernel and confirm `uname -r` reports 5.17 or later:
```bash
sudo apt install linux-generic-hwe-22.04
```
:::

## Cloud Provider Notes

Kloak has not been tested on managed Kubernetes services. It is expected to work on any managed node image whose kernel is **5.17+**, with BTF and cgroup v2. Check the kernel and container runtime versions on your nodes:

```bash
kubectl get nodes -o wide  # Check the KERNEL-VERSION and CONTAINER-RUNTIME columns
```

A node image with containerd 2.0+ or CRI-O 1.30+ also gets the NRI hook (see [Container Runtime (NRI)](#container-runtime-nri)).

### Amazon EKS

- Use Amazon Linux 2023 or Ubuntu 24.04 node AMIs. Amazon Linux 2 (kernel 5.10) is too old.
- The webhook Service listens on port 443 and forwards to the webhook pods on **TCP 9443**. The control plane must be able to reach the pods on 9443 (check node security groups).

### Google GKE

- GKE Autopilot does **not** allow privileged DaemonSets, which Kloak requires. Use GKE Standard.
- Verify that the node image kernel is 5.17+.

### Azure AKS

- Verify that the node image kernel is 5.17+. Ubuntu 22.04 node images with the 5.15 kernel are too old.
- AKS with Kata Containers / confidential nodes: not supported.

## Resource Requirements

### Controller DaemonSet (per node)

| Resource | Request | Limit | Notes |
|---|---|---|---|
| CPU | 10m | 500m | eBPF attachment is CPU-light; reconciliation is the main consumer |
| Memory | 64Mi | 512Mi | BPF maps + informer cache |

### Webhook Deployment

| Resource | Request | Limit | Notes |
|---|---|---|---|
| CPU | 10m | 500m | Admission requests are fast (JSON patch generation) |
| Memory | 64Mi | 128Mi | Stateless; only caches Kubernetes client objects |

### Kernel Resources

| Resource | Size | Notes |
|---|---|---|
| BPF map: `secret_map` | Scales with number of secrets | ~280 bytes per entry (8B key + 272B value), max 4096 entries; each secret value uses 2 entries |
| BPF maps: `vip_host_ip`, `vip_ip_host`, `vip_upstream` | Scale with unique host filters | max 1024 / 4096 / 4096 entries; pinned under `/sys/fs/bpf/kloak` until the node reboots |
| BPF maps: `vip_sock_host`, `vip_sock_dst`, `sni_state` | Scale with active connections | LRU, max 65536 entries each |
| BPF map: `conn_ip_map` | Scales with active TCP connections | LRU, max 16384 entries |
| BPF map: `secret_acl` | Scales with bound pods and their secrets | max 65536 entries |
| Ring buffer: `secret_binding_events` | Fixed size (compile-time) | 64KB |
| Ring buffer: `proc_events` | Fixed size (compile-time) | 64KB |
| eBPF programs | 21 programs | TLS uprobes (OpenSSL/BoringSSL `SSL_write`, Go `crypto/tls`, cipher-init hooks, rewrite tail calls), two `tcp_sendmsg` kprobes (SNI capture, patch filter), socket-state, connect/close and exec/exit tracepoints, tc programs (ciphertext patch, GHASH update, DNS rewrite), cgroup connect and getpeername programs |

## Verification Checklist

Run these checks on a node to verify Kloak compatibility:

```bash
# 1. Kernel version (must be 5.17+; 6.6+ uses TCX)
uname -r

# 2. BTF availability
ls -la /sys/kernel/btf/vmlinux

# 3. cgroup v2
stat -fc %T /sys/fs/cgroup   # must print cgroup2fs

# 4. Uprobe support
ls /sys/kernel/tracing/uprobe_events 2>/dev/null && \
  echo "Uprobes available" || echo "Uprobes not available (check CONFIG_UPROBES and tracefs)"
```

::: tip
The simplest check is the kernel version: a 5.17+ kernel from a major distribution with BTF and cgroup v2 enabled has all required features.
:::
