# Installation

This guide walks you through deploying Kloak into your Kubernetes cluster. The entire process takes about two minutes.

## Prerequisites

Before installing Kloak, make sure your environment meets the following requirements:

| Requirement | Minimum Version | Notes |
|---|---|---|
| Kubernetes | 1.28+ | Tested in CI on k3s; other conformant distributions (EKS, GKE, AKS) are expected to work when the node kernel meets the requirement below |
| Linux kernel | 5.17+ | Required on worker nodes (`bpf_loop`). 6.6+ is recommended: the tc patch program attaches via TCX there, and via a classic `clsact` filter on older kernels. Kernel BTF must be available. |
| Helm | 3.x | Used for installing and managing Kloak |
| kubectl | 1.28+ | Configured with cluster access |
| cgroup v2 | Enabled | Most modern distributions enable this by default |
| CPU architecture | amd64 or arm64 | |
| Container runtime | containerd 2.0+ or CRI-O 1.30+ recommended | Their NRI hook lets Kloak prepare each pod before its containers start. Other runtimes work with a short window at pod start; see [Requirements](/reference/requirements#container-runtime-nri) |
| Free address ranges | `198.18.0.0/15` and `2001:2::/48` by default | Kloak hands out virtual IPs from them for host-restricted secrets. They must not be used by the cluster or its nodes; see [Virtual IP ranges](/reference/requirements#virtual-ip-ranges) |

::: tip Checking your kernel version
Run the following on your worker nodes to verify kernel compatibility:
```bash
uname -r
```
The output should show `5.17` or higher (e.g., `6.1.0-18-amd64` or `6.8.0-45-generic`). On 5.17 – 6.5 Kloak uses a classic `clsact` tc filter instead of TCX; see [Requirements](/reference/requirements#minimum-linux-5-17) for what that means with your CNI.
:::

::: warning eBPF requires privileged access
The Kloak controller runs as a privileged DaemonSet with `CAP_BPF`, `CAP_NET_ADMIN`, `CAP_SYS_ADMIN`, and `CAP_SYS_RESOURCE`. This is required to load eBPF programs and attach uprobes to container processes.
:::

## Install with Helm

Add the Kloak Helm repository and install:

```bash
helm repo add kloak https://chart.getkloak.io
helm repo update

helm install kloak kloak/kloak --version 0.3.0 \
  -n kloak-system --create-namespace
```

This installs chart version 0.3.0, which pulls the matching image `ghcr.io/spinningfactory/kloak:0.3.0`. Without `--version`, Helm installs the latest stable chart. Nightly builds of `main` are published as `0.0.1-nightly-<sha>` pre-release charts; add `--devel` to install one.

This creates the `kloak-system` namespace and deploys two components:

- **kloak-controller** -- A DaemonSet that runs on every node. It watches secrets, creates shadow copies, and loads eBPF programs to intercept TLS writes.
- **kloak-webhook** -- A Deployment that runs the mutating admission webhook. It intercepts pod creation and rewrites Secret references (volumes, `env[].valueFrom.secretKeyRef`, and `envFrom[].secretRef`) to point to Kloak shadow secrets. It also runs a validating webhook that rejects kloak-enabled Secrets Kloak cannot protect.

In `auto` certificate mode (the default), Helm generates a self-signed TLS certificate at install time, stores it in the `kloak-webhook-certs` secret, and sets the `caBundle` on the `MutatingWebhookConfiguration` and `ValidatingWebhookConfiguration`. No manual certificate management is needed.

At startup the controller checks that its virtual IP ranges don't overlap any address range of the cluster or its node. If they do, it logs the overlapping range and exits; set `controller.ebpf.virtualIPRange` to free ranges (see [Configuration](./configuration.md#virtual-ip-ranges)).

## Upgrading from v0.2.x and Earlier

In v0.3.0, secrets restricted to a hostname use [virtual IPs](/guides/host-filtering#how-host-resolution-works) instead of reading the DNS answers pods receive:

- **Restart kloak-enabled pods after the upgrade.** Pods that were already running keep the addresses they resolved before, and a connection to a real address gets no host-restricted secret.
- If the controller refuses to start because a virtual IP range overlaps an address range of the cluster or a node, set `controller.ebpf.virtualIPRange` to free ranges.
- A secret restricted to a hostname is now only rewritten on a connection whose TLS SNI is that host. Clients that connect through a different name than the one in `getkloak.io/hosts` (for example a short in-cluster Service name) send the placeholder; see [SNI check](/guides/host-filtering#sni-check).

## Verify the Installation

Check that all Kloak pods are running:

```bash
kubectl get pods -n kloak-system
```

You should see output similar to:

```
NAME                             READY   STATUS    RESTARTS   AGE
kloak-controller-abcde           1/1     Running   0          45s
kloak-webhook-6f7b8c9d10-xyz12   1/1     Running   0          40s
```

Wait for both pods to reach `Running` status.

You can also verify the components are healthy with rollout status:

```bash
kubectl rollout status daemonset/kloak-controller -n kloak-system --timeout=120s
kubectl rollout status deployment/kloak-webhook -n kloak-system --timeout=120s
```

### Verify the Webhook

Confirm that the mutating and validating webhook configurations were created and have a CA bundle:

```bash
kubectl get mutatingwebhookconfiguration kloak-mutating-webhook
kubectl get validatingwebhookconfiguration kloak-validating-webhook

# Should print the start of a base64-encoded certificate, not an empty line
kubectl get mutatingwebhookconfiguration kloak-mutating-webhook \
  -o jsonpath='{.webhooks[0].clientConfig.caBundle}' | head -c 40; echo
```

## Customizing the Installation

The image tag defaults to the chart's version. Override any value in the Helm chart using `--set` or a custom values file:

```bash
helm install kloak kloak/kloak --version 0.3.0 \
  -n kloak-system --create-namespace \
  --set image.repository=ghcr.io/spinningfactory/kloak \
  --set image.tag=0.3.0
```

Or create a custom values file:

```yaml
# my-values.yaml
image:
  repository: ghcr.io/spinningfactory/kloak
  tag: 0.3.0

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
helm install kloak kloak/kloak --version 0.3.0 \
  -n kloak-system --create-namespace \
  -f my-values.yaml
```

## Uninstall

To remove Kloak and all its resources from your cluster:

```bash
helm uninstall kloak -n kloak-system
kubectl delete namespace kloak-system
```

Shadow secrets created by Kloak in application namespaces are **not** automatically deleted. To clean those up:

```bash
kubectl delete secrets -l getkloak.io/managed=true --all-namespaces
```

::: warning
Removing Kloak while applications are running means pods will continue to see the shadow secret values (`kl::…` placeholders) until they are restarted with the original secrets. Plan your rollback accordingly.
:::

The virtual IP maps stay pinned under `/sys/fs/bpf/kloak` on each node until it reboots. To remove them sooner, delete that directory on each node after uninstalling.

## Next Steps

- Follow the [Quick Start](./quick-start.md) to protect your first secret in under five minutes.
- Review [Configuration](./configuration.md) for controller and webhook tuning options.
