# Configuration

This page covers all configuration options for the Kloak controller and webhook, namespace and workload enablement, and production resource tuning.

## Controller Flags

The controller runs as a DaemonSet on every node. It manages secret reconciliation and eBPF uprobe attachment.

| Flag | Default | Description |
|---|---|---|
| `--health-probe-bind-address` | `:8081` | Address for health (`/healthz`) and readiness (`/readyz`) probe endpoints. |
| `--cgroup-path` | `/sys/fs/cgroup` | Path to the cgroup v2 filesystem. When running in a container with a host mount, this is typically `/host/sys/fs/cgroup`. |
| `--trusted-dns-servers` | *(empty)* | Comma-separated list of trusted DNS server IPs. Only DNS responses from these IPs are used for host filtering. The `kube-dns` cluster IP is always auto-discovered at startup and added to this list. Set via the Helm value `controller.dns.trustedServers` (a YAML list). |
| `--enable-ebpf` | `false` | Load the eBPF programs and attach TLS uprobes. The Helm chart sets this to `true` (`controller.ebpf.enabled`). |

The tc patch program is always attached to the pod's `eth0` and `lo` interfaces, through TCX (Linux 6.6+).

### Environment Variables

The controller and webhook read these environment variables (set automatically by the chart):

| Variable | Description |
|---|---|
| `NODE_NAME` | The Kubernetes node name. Used to filter pod watches so each controller instance only manages pods on its own node. Populated from `spec.nodeName` via the downward API. |
| `KLOAK_LOG_LEVEL` | Log level: `trace`, `debug`, `info`, `warn`, or `error`. From the Helm value `log.level` (default `info`). Controller and webhook. |
| `KLOAK_LOG_DEV` | `true` switches to human-readable console logs. From `log.dev` (default `false`). Controller and webhook. |
| `POD_NAMESPACE` | Set on the controller from `metadata.namespace`. Currently unused. |

## Webhook Flags

The webhook runs as a Deployment and serves the mutating (pod) admission endpoint.

| Flag | Default | Description |
|---|---|---|
| `--health-probe-bind-address` | `:8081` | Address for health and readiness probe endpoints. |
| `--cert-dir` | `/certs` | Directory containing the TLS certificate and key files (`tls.crt`, `tls.key`). Mounted from the `kloak-webhook-certs` secret, or from `certificates.provided.secretName` in `provided` mode. |

The webhook listens on port `9443` for admission requests. The `Service` fronting the webhook maps port `443` to this target port.

## Webhook Certificates

Kubernetes requires all admission webhooks to serve TLS. When the API server intercepts a pod creation and forwards it to Kloak's mutating webhook, the connection must be encrypted. The API server also needs a trusted CA bundle to verify the webhook's certificate -- this is set in the `caBundle` field of the `MutatingWebhookConfiguration`.

Kloak needs a TLS certificate and key pair for the webhook service, and the corresponding CA certificate must be registered with the API server so it trusts the webhook endpoint.

Certificate management is configured via the Helm value `certificates.mode`:

### `auto` (default)

Helm generates a self-signed TLS certificate at install time, stores it in the `kloak-webhook-certs` secret, and sets the `caBundle` on the webhook configuration. This is the recommended mode for most deployments -- no additional setup required.

### `certManager`

Integrates with [cert-manager](https://cert-manager.io/). Helm creates a `Certificate` and `Issuer` resource. The cert-manager `cainjector` automatically patches the `caBundle` on the webhook configuration. Use this mode if you already run cert-manager and want automated certificate rotation.

```yaml
# values.yaml
certificates:
  mode: certManager
  certManager:
    issuerRef:
      name: kloak-selfsigned
      kind: Issuer
```

### `provided`

Helm skips certificate generation entirely and expects the secret named by `certificates.provided.secretName` (default `kloak-webhook-certs`) to already exist. The chart does **not** set a `caBundle` in this mode: either the certificate must chain to a CA the API server already trusts, or you must set `caBundle` on the webhook configuration yourself (for example with cert-manager's `cainjector`). Use this mode when managing certificates externally (e.g., through your own PKI or a secrets management tool).

```yaml
# values.yaml
certificates:
  mode: provided
  provided:
    secretName: kloak-webhook-certs
    certKey: tls.crt
    keyKey: tls.key
```

::: tip Using cert-manager with provided mode
If you prefer full control, you can use `provided` mode with a cert-manager `Certificate` resource targeting the `kloak-webhook-certs` secret. You will need to set the `caBundle` on the `MutatingWebhookConfiguration` yourself, or use cert-manager's `cainjector`.
:::

## Enablement Model

Kloak uses a strict opt-in model. Nothing is intercepted unless explicitly enabled. For Kloak to protect a secret end-to-end, two things must be enabled independently:

1. **The secret itself** -- tells Kloak *which* secrets to protect. Enabling a secret causes the controller to create a shadow copy with random `kloak:` placeholders and load the shadow-to-real mapping into the eBPF map on each node. Without this, no shadow secret exists and there is nothing to rewrite.

2. **The workload** -- tells Kloak *which* pods should have their TLS writes intercepted. Enabling a workload causes the webhook to rewrite secret volumes to point to shadow secrets, and the controller to attach eBPF uprobes to the pod's process. Without this, the pod mounts the original secret and no eBPF interception occurs.

Both sides are required. Enabling only the secret creates the shadow copy but no pod uses it. Enabling only the workload attaches uprobes but rewrites nothing, because the webhook only rewrites volumes of kloak-enabled secrets.

### Secret Enablement

Label any secret to have Kloak create a shadow copy. Destination filters are **labels** too:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: my-secret
  labels:
    getkloak.io/enabled: "true"           # Required: triggers shadow secret creation
    getkloak.io/hosts: "api.example.com"  # Optional: restrict allowed destination host
    getkloak.io/port: "443"               # Optional: restrict allowed destination port
type: Opaque
stringData:
  token: "my-real-token-value"
```

::: warning
In this release `getkloak.io/hosts` and `getkloak.io/port` are **labels**. Set as annotations, they are ignored, and the secret is rewritten for any destination. (They became annotations in v0.1.2.)
:::

Label values are limited to 63 characters of letters, digits, `-`, `_` and `.`. So `getkloak.io/hosts` holds a single hostname (`*` is not a valid label value: omit the label to allow any host), and `getkloak.io/port` a port number, for TCP.

When the `SecretReconciler` detects this label, it creates `my-secret-kloak` with a random `kloak:` placeholder for each key, exactly as long as the real value. Every 5 seconds the controller joins each enabled secret with its shadow and syncs the shadow-to-real mapping into the eBPF map in the kernel. The original secret is untouched.

Nothing validates kloak-enabled Secrets at admission in this release (a validating webhook was added in v0.1.1). Check them yourself:

- each value must be 8 to 128 bytes long: if any value is shorter than 8 bytes, no shadow is created for the whole Secret and pods that mount it are rejected; longer values are truncated to 128 bytes, so the rewrite is wrong
- the `getkloak.io/hosts` label must be a lowercase hostname, as DNS answers carry it, or it never matches
- the `getkloak.io/port` label must be a valid port, or it is ignored (any port)

### Workload Enablement

Workloads can be enabled at two levels -- pod label or namespace label. The `kloak-mutating-webhook` configuration has two webhooks with Kubernetes selectors so that only kloak-enabled namespaces and pods are sent to the webhook. Non-kloak workloads are never affected, even if the webhook is down.

#### Pod Label

Label individual pods (via the pod template in a Deployment/StatefulSet/DaemonSet):

```yaml{6-7}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
spec:
  template:
    metadata:
      labels:
        getkloak.io/enabled: "true"
    spec:
      containers:
        - name: app
          # ...
```

When the pod is created, the webhook rewrites `secret` volumes that reference kloak-enabled secrets to the shadow secret. It also adds the `getkloak.io/enabled` annotation so the controller knows to attach eBPF uprobes. If the shadow secret has not been created yet (controller hasn't reconciled), or isn't a Kloak-managed shadow, the webhook **rejects** the pod to prevent real secrets from being mounted.

::: danger Only secret volumes are rewritten
In this release the webhook does not rewrite environment variables (`env[].valueFrom.secretKeyRef`, `envFrom[].secretRef`) or projected volume sources. A pod that reads a kloak-enabled secret through them gets the **real value**. Mount protected secrets as `secret` volumes.
:::

#### Namespace Label

Enables Kloak for all pods in a namespace. Useful when an entire namespace should be protected:

```bash
kubectl label namespace my-namespace getkloak.io/enabled=true
```

Every pod created in this namespace is treated as Kloak-enabled, even without an explicit pod label.

::: warning
Labeling a namespace enables Kloak for **every** pod in that namespace. Make sure all applications are compatible (see [Supported Runtimes](/guides/supported-runtimes)). Pods using unsupported TLS stacks will fail to have uprobes attached, which is logged as an error but does not block the pod.
:::

### Enablement Precedence

The webhook checks enablement in the following order, stopping at the first match:

1. **Pod label** -- if the pod has the `getkloak.io/enabled` label, its value decides: `"true"` enables Kloak, any other value (for example `"false"`) opts the pod out, even in an enabled namespace.
2. **Namespace label** -- `getkloak.io/enabled: "true"` on the pod's namespace.

If neither enables it, the pod is not processed by Kloak. Pods in Kloak's own release namespace are never mutated, and a pod *annotation* does not enable Kloak.

::: tip
Workload-level inheritance (Deployment, DaemonSet, StatefulSet labels) is not supported. Use pod template labels or namespace labels instead.
:::

### Host Filtering

The `getkloak.io/hosts` label on a secret controls which TLS destinations receive the real value:

```yaml
labels:
  getkloak.io/hosts: "api.example.com"   # A single hostname
  getkloak.io/port: "443"                # Optional: a TCP port
```

Set as annotations, either key is ignored: the secret has no host or port restriction.

A single hostname only. Label values can't contain commas, so a secret can't list several hosts (see [spinningfactory/kloak#102](https://github.com/spinningfactory/kloak/issues/102)). IP addresses are not supported in this release: an address is treated as a hostname, never matches, and the secret is never rewritten.

When a TLS write is intercepted, the eBPF program resolves the destination hostname via the DNS-verified trust chain (DNS capture -> connection tracking -> host resolution). If the resolved hostname does not match the allowed host, the placeholder is **not** replaced -- the remote server receives the harmless `kloak:...` placeholder. See the [Host Filtering guide](/guides/host-filtering) for details.

Omitting `getkloak.io/hosts` allows the secret to be sent to any destination. Wildcard subdomains such as `*.example.com` are not supported.

## Helm Values

| Key | Default | Description |
|---|---|---|
| `image.repository` | `ghcr.io/spinningfactory/kloak` | Controller and webhook image. |
| `image.tag` | chart version | Release charts pin the matching image version. |
| `image.pullPolicy` | `IfNotPresent` | |
| `log.level` | `info` | `trace`, `debug`, `info`, `warn`, `error`. |
| `log.dev` | `false` | Human-readable console logs. |
| `controller.ebpf.enabled` | `true` | Passed as `--enable-ebpf`. |
| `controller.cgroupPath` | `/host/sys/fs/cgroup` | Passed as `--cgroup-path`. |
| `controller.dns.trustedServers` | `[]` | Extra trusted DNS server IPs, joined into `--trusted-dns-servers`. |
| `controller.resources` | see below | |
| `webhook.replicas` | `1` | |
| `webhook.resources` | see below | |
| `certificates.mode` | `auto` | `auto`, `certManager`, or `provided` (see [Webhook Certificates](#webhook-certificates)). |
| `demo.enabled` | `false` | Deploys a demo app and two demo secrets in `demo.namespace` (`kloak-demo`). |

### Default Resources

The default Helm values include conservative resource defaults suitable for development and testing:

**Controller (DaemonSet):**
```yaml
resources:
  requests:
    cpu: 10m
    memory: 64Mi
  limits:
    cpu: 500m
    memory: 512Mi
```

**Webhook (Deployment):**
```yaml
resources:
  requests:
    cpu: 10m
    memory: 64Mi
  limits:
    cpu: 500m
    memory: 128Mi
```

::: tip Sizing for your workload
The controller's memory usage scales with the number of secrets being tracked and the number of pods being monitored on each node. For clusters with hundreds of secrets, consider increasing the memory limit to `1Gi`. The eBPF programs themselves have minimal overhead once loaded.
:::

### Custom Resource Overrides

Override resources via Helm values:

```yaml
# my-values.yaml
controller:
  resources:
    requests:
      cpu: 100m
      memory: 128Mi
    limits:
      cpu: "1"
      memory: 1Gi
```

```bash
helm upgrade kloak kloak/kloak -n kloak-system -f my-values.yaml
```

## Ports Reference

| Component | Port | Purpose |
|---|---|---|
| Controller | 8081 | Health and readiness probes |
| Webhook | 8081 | Health and readiness probes |
| Webhook | 9443 | Admission webhook endpoint (TLS) |

## Security Context

The controller requires elevated privileges for eBPF operations. The manifest sets:

```yaml
securityContext:
  privileged: true
  runAsUser: 0
  runAsGroup: 0
  appArmorProfile:
    type: Unconfined
  capabilities:
    add:
      - BPF
      - NET_ADMIN
      - SYS_ADMIN
      - SYS_RESOURCE
```

The controller also requires `hostPID: true` at the pod level to see container processes (`/proc/<pid>/root`, `/proc/<pid>/exe`) for uprobe attachment and to enter each pod's network namespace when attaching the tc program.

The webhook does **not** require any elevated privileges and runs with default security settings.

## Volume Mounts (Controller)

The controller DaemonSet mounts four host paths:

| Mount Path | Host Path | Access | Purpose |
|---|---|---|---|
| `/host/sys/fs/cgroup` | `/sys/fs/cgroup` | Read-write | Cgroup v2 filesystem for resolving container cgroup IDs |
| `/sys/fs/bpf` | `/sys/fs/bpf` | Read-write | BPF filesystem (mounted, but nothing is pinned today; programs and maps are released when the controller stops) |
| `/sys/kernel/btf` | `/sys/kernel/btf` | Read-only | Kernel BTF (BPF Type Format) data for CO-RE (Compile Once, Run Everywhere) |
| `/sys/kernel/tracing` | `/sys/kernel/tracing` | Read-write (Bidirectional) | Tracefs for eBPF tracepoint and kprobe attachment. The `mount-tracefs` init container mounts tracefs here. |
