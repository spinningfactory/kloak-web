# Installation

This guide walks you through deploying Kloak into your Kubernetes cluster. The entire process takes about two minutes.

## Prerequisites

Before installing Kloak, make sure your environment meets the following requirements:

| Requirement | Minimum Version | Notes |
|---|---|---|
| Kubernetes | 1.28+ | Tested in CI on k3s; other conformant distributions (EKS, GKE, AKS) are expected to work when the node kernel meets the requirement below |
| Linux kernel | 6.6+ | Required on worker nodes. The eBPF programs load on 5.17+ (`bpf_loop`), but the tc program that patches ciphertext attaches through TCX, which needs 6.6: on older kernels nothing is rewritten. Kernel BTF must be available. |
| Helm | 3.x | Used for installing and managing Kloak |
| kubectl | 1.28+ | Configured with cluster access |
| cgroup v2 | Enabled | Most modern distributions enable this by default |
| CPU architecture | amd64 or arm64 | |

::: tip Checking your kernel version
Run the following on your worker nodes to verify kernel compatibility:
```bash
uname -r
```
The output should show `6.6` or higher (e.g., `6.8.0-45-generic`). See [Requirements](/reference/requirements#minimum-linux-6-6) for details.
:::

::: warning eBPF requires privileged access
The Kloak controller runs as a privileged DaemonSet with `CAP_BPF`, `CAP_NET_ADMIN`, `CAP_SYS_ADMIN`, and `CAP_SYS_RESOURCE`. This is required to load eBPF programs and attach uprobes to container processes.
:::

## Install with Helm

Add the Kloak Helm repository and install:

```bash
helm repo add kloak https://chart.getkloak.io
helm repo update

helm install kloak kloak/kloak --version 0.1.0 \
  -n kloak-system --create-namespace
```

This installs chart version 0.1.0, which pulls the matching image `ghcr.io/spinningfactory/kloak:0.1.0`. Without `--version`, Helm installs the latest stable chart.

This creates the `kloak-system` namespace and deploys two components:

- **kloak-controller** -- A DaemonSet that runs on every node. It watches secrets, creates shadow copies, and loads eBPF programs to intercept TLS writes.
- **kloak-webhook** -- A Deployment that runs the mutating admission webhook. It intercepts pod creation and rewrites Secret volumes (`volumes[].secret`) to point to Kloak shadow secrets.

In `auto` certificate mode (the default), Helm generates a self-signed TLS certificate at install time, stores it in the `kloak-webhook-certs` secret, and sets the `caBundle` on the `MutatingWebhookConfiguration`. No manual certificate management is needed.

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

Confirm that the mutating webhook configuration was created and has a CA bundle:

```bash
kubectl get mutatingwebhookconfiguration kloak-mutating-webhook

# Should print the start of a base64-encoded certificate, not an empty line
kubectl get mutatingwebhookconfiguration kloak-mutating-webhook \
  -o jsonpath='{.webhooks[0].clientConfig.caBundle}' | head -c 40; echo
```

## Customizing the Installation

The image tag defaults to the chart's version. Override any value in the Helm chart using `--set` or a custom values file:

```bash
helm install kloak kloak/kloak --version 0.1.0 \
  -n kloak-system --create-namespace \
  --set image.repository=ghcr.io/spinningfactory/kloak \
  --set image.tag=0.1.0
```

Or create a custom values file:

```yaml
# my-values.yaml
image:
  repository: ghcr.io/spinningfactory/kloak
  tag: 0.1.0

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
helm install kloak kloak/kloak --version 0.1.0 \
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
Removing Kloak while applications are running means pods will continue to see the shadow secret values (`kloak:…` placeholders) until they are restarted with the original secrets. Plan your rollback accordingly.
:::

## Next Steps

- Follow the [Quick Start](./quick-start.md) to protect your first secret in under five minutes.
- Review [Configuration](./configuration.md) for controller and webhook tuning options.
