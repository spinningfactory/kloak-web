# Installation

This guide walks you through deploying Kloak into your Kubernetes cluster. The entire process takes about two minutes.

## Prerequisites

Before installing Kloak, make sure your environment meets the following requirements:

| Requirement | Minimum Version | Notes |
|---|---|---|
| Kubernetes | 1.28+ | Any conformant distribution (EKS, GKE, AKS, k3s, etc.) |
| Linux kernel | 5.17+ | Required on worker nodes for `bpf_loop` support |
| Helm | 3.12+ | Used for installing and managing Kloak |
| kubectl | 1.28+ | Configured with cluster access |
| cgroup v2 | Enabled | Most modern distributions enable this by default |

::: tip Checking your kernel version
Run the following on your worker nodes to verify kernel compatibility:
```bash
uname -r
```
The output should show `5.17` or higher (e.g., `6.1.0-18-amd64`).
:::

::: warning eBPF requires privileged access
The Kloak controller runs as a privileged DaemonSet with `CAP_BPF`, `CAP_NET_ADMIN`, `CAP_SYS_ADMIN`, and `CAP_SYS_RESOURCE`. This is required to load eBPF programs and attach uprobes to container processes.
:::

## Install with Helm

Add the Kloak Helm repository and install:

```bash
helm repo add kloak https://getkloak.github.io/kloak
helm repo update

helm install kloak kloak/kloak \
  -n kloak-system --create-namespace
```

This creates the `kloak-system` namespace and deploys two components:

- **kloak-controller** -- A DaemonSet that runs on every node. It watches secrets, creates shadow copies, and loads eBPF programs to intercept TLS writes.
- **kloak-webhook** -- A Deployment that runs the mutating admission webhook. It intercepts pod creation and rewrites secret volume references to point to Kloak shadow secrets.

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

Confirm that the mutating webhook configuration was created and has a valid CA bundle:

```bash
kubectl get mutatingwebhookconfiguration kloak-mutating-webhook
```

## Customizing the Installation

Override any value in the Helm chart using `--set` or a custom values file:

```bash
helm install kloak kloak/kloak \
  -n kloak-system --create-namespace \
  --set image.repository=your-registry.example.com/kloak \
  --set image.tag=v1.2.3
```

Or create a custom values file:

```yaml
# my-values.yaml
image:
  repository: your-registry.example.com/kloak
  tag: v1.2.3

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
helm install kloak kloak/kloak \
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
Removing Kloak while applications are running means pods will continue to see the shadow secret values (`kloak:<ULID>` placeholders) until they are restarted with the original secrets. Plan your rollback accordingly.
:::

## Next Steps

- Follow the [Quick Start](./quick-start.md) to protect your first secret in under five minutes.
- Review [Configuration](./configuration.md) for controller and webhook tuning options.
