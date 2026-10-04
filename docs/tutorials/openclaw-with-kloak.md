# Deploy OpenClaw with Kloak

This tutorial walks you through deploying [OpenClaw](https://github.com/openclaw/openclaw) on Kubernetes with all LLM API keys protected by Kloak. By the end, your OpenClaw instance will have zero knowledge of your real API keys -- inside the pod, only `kl::` placeholders exist, and the real keys are injected in-kernel into the encrypted TLS traffic as it leaves the pod.

## What You Will Build

```
OpenClaw Pod                          LLM Providers
+-------------------------+
| Gateway Container       |
|                         |     TLS write          +------------------+
| OPENAI_API_KEY=         |  ------------------>   | api.openai.com   |
|   kl::osUMhUh;tRh2...   |  eBPF rewrites with    | (real key sent)  |
|                         |  real key in-kernel     +------------------+
| GEMINI_API_KEY=         |  ------------------>   +------------------+
|   kl::n;8m4z;eeeo...    |                        | generativelanguage|
|                         |                        | .googleapis.com  |
+-------------------------+                        +------------------+
```

Your OpenClaw gateway reads `kl::` placeholders from mounted secret files. When it makes API calls to Anthropic, OpenAI, Gemini, or other providers, Kloak's eBPF uprobe intercepts the TLS write and Kloak patches the real keys into the encrypted traffic as it leaves the pod -- scoped to the correct provider host.

## Prerequisites

- A running Kubernetes cluster (1.28+, Linux kernel 5.17+) with [Kloak installed](/getting-started/installation)
- `kubectl` configured and pointed at your cluster
- An Anthropic API key, plus optionally OpenAI and/or Google Gemini keys

## Step 1: Create the Namespace

Create a namespace for OpenClaw and enable Kloak:

```bash
kubectl create namespace openclaw
kubectl label namespace openclaw getkloak.io/enabled=true
```

## Step 2: Create Kloak-Protected Secrets

Create separate secrets for each LLM provider, each with a host filter that restricts where the key can be sent. This is the key security property -- even if OpenClaw is compromised, each API key can only be sent to its intended provider.

`getkloak.io/enabled` must be a **label**, and `getkloak.io/hosts` must be an **annotation**. Kloak's validating webhook rejects a Secret that sets `getkloak.io/hosts` as a label.

### Anthropic API Key

```yaml
# anthropic-secret.yaml
apiVersion: v1
kind: Secret
metadata:
  name: anthropic-api-key
  namespace: openclaw
  labels:
    getkloak.io/enabled: "true"
  annotations:
    getkloak.io/hosts: "api.anthropic.com"
type: Opaque
stringData:
  ANTHROPIC_API_KEY: "sk-ant-your-real-anthropic-key-here"
```

### OpenAI API Key (optional)

```yaml
# openai-secret.yaml
apiVersion: v1
kind: Secret
metadata:
  name: openai-api-key
  namespace: openclaw
  labels:
    getkloak.io/enabled: "true"
  annotations:
    getkloak.io/hosts: "api.openai.com"
type: Opaque
stringData:
  OPENAI_API_KEY: "sk-your-real-openai-key-here"
```

### Google Gemini API Key (optional)

```yaml
# gemini-secret.yaml
apiVersion: v1
kind: Secret
metadata:
  name: gemini-api-key
  namespace: openclaw
  labels:
    getkloak.io/enabled: "true"
  annotations:
    getkloak.io/hosts: "generativelanguage.googleapis.com"
type: Opaque
stringData:
  GEMINI_API_KEY: "your-real-gemini-key-here"
```

### Gateway Token

The gateway token is used for authenticating clients to the OpenClaw gateway. Create it as a **plain** Secret, without the `getkloak.io/enabled` label: Kloak only rewrites outbound TLS traffic, so a Kloak-managed token would leave OpenClaw comparing incoming client tokens against the placeholder (and, with no host filter, the real token would be injected into any outbound TLS write containing it).

```yaml
# gateway-token-secret.yaml
apiVersion: v1
kind: Secret
metadata:
  name: openclaw-gateway-token
  namespace: openclaw
  # No getkloak.io/enabled label -- this token is verified locally
  # by OpenClaw, so Kloak must not replace it with a placeholder.
type: Opaque
stringData:
  OPENCLAW_GATEWAY_TOKEN: "your-long-random-gateway-token-here"
```

Apply all secrets:

```bash
kubectl apply -f anthropic-secret.yaml
kubectl apply -f openai-secret.yaml       # if using OpenAI
kubectl apply -f gemini-secret.yaml       # if using Gemini
kubectl apply -f gateway-token-secret.yaml
```

Verify shadow secrets were created:

```bash
kubectl get secrets -n openclaw
```

```
NAME                             TYPE     DATA   AGE
anthropic-api-key                Opaque   1      5s
anthropic-api-key-kloak          Opaque   1      5s
openai-api-key                   Opaque   1      5s
openai-api-key-kloak             Opaque   1      5s
gemini-api-key                   Opaque   1      5s
gemini-api-key-kloak             Opaque   1      5s
openclaw-gateway-token           Opaque   1      5s
```

Each `-kloak` shadow secret contains a `kl::` placeholder with the same byte length (and HPACK Huffman bit length) as your real key. The gateway token has no shadow because it is not Kloak-managed.

## Step 3: Create the OpenClaw ConfigMap

OpenClaw needs a configuration file and optionally agent instructions:

```yaml
# openclaw-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: openclaw-config
  namespace: openclaw
data:
  openclaw.json: |
    {
      "gateway": {
        "port": 18789,
        "host": "0.0.0.0"
      }
    }
  AGENTS.md: |
    You are a helpful AI assistant running on a Kloak-protected Kubernetes cluster.
    Your API keys are secured by eBPF -- you never see the real credentials.
```

```bash
kubectl apply -f openclaw-config.yaml
```

## Step 4: Create the PersistentVolumeClaim

OpenClaw stores conversation history and state on disk:

```yaml
# openclaw-pvc.yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: openclaw-data
  namespace: openclaw
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 10Gi
```

```bash
kubectl apply -f openclaw-pvc.yaml
```

## Step 5: Deploy OpenClaw

Deploy OpenClaw with secrets mounted as **volumes**. Kloak's webhook rewrites secret volume references to point to shadow secrets -- this is how the application receives `kl::` placeholders instead of real values. A wrapper script reads the mounted files into environment variables before starting OpenClaw.

::: tip
Kloak's webhook also rewrites `env[].valueFrom.secretKeyRef` and `envFrom[].secretRef` references to kloak-enabled secrets, so those are protected too. Volumes are used here so the optional provider keys can be loaded only when present. Projected volume sources are not rewritten.
:::

```yaml
# openclaw-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: openclaw
  namespace: openclaw
  labels:
    app: openclaw
spec:
  replicas: 1
  selector:
    matchLabels:
      app: openclaw
  template:
    metadata:
      labels:
        app: openclaw
        getkloak.io/enabled: "true"
    spec:
      initContainers:
        - name: init-config
          image: busybox:1.36
          command:
            - sh
            - -c
            - |
              mkdir -p /home/node/.openclaw
              cp /config/openclaw.json /home/node/.openclaw/openclaw.json
              cp /config/AGENTS.md /home/node/.openclaw/AGENTS.md
              chown -R 1000:1000 /home/node/.openclaw
          volumeMounts:
            - name: data
              mountPath: /home/node/.openclaw
            - name: config
              mountPath: /config
              readOnly: true
      containers:
        - name: gateway
          image: ghcr.io/openclaw/openclaw:slim
          ports:
            - containerPort: 18789
              name: gateway
          command: ["sh", "-c"]
          args:
            - |
              # Read secrets from mounted files into env vars
              export ANTHROPIC_API_KEY=$(cat /etc/secrets/anthropic/ANTHROPIC_API_KEY)
              export OPENCLAW_GATEWAY_TOKEN=$(cat /etc/secrets/gateway/OPENCLAW_GATEWAY_TOKEN)
              [ -f /etc/secrets/openai/OPENAI_API_KEY ] && export OPENAI_API_KEY=$(cat /etc/secrets/openai/OPENAI_API_KEY)
              [ -f /etc/secrets/gemini/GEMINI_API_KEY ] && export GEMINI_API_KEY=$(cat /etc/secrets/gemini/GEMINI_API_KEY)
              exec node /app/gateway.js
          env:
            - name: HOME
              value: /home/node
            - name: OPENCLAW_CONFIG_DIR
              value: /home/node/.openclaw
            - name: NODE_ENV
              value: production
          volumeMounts:
            - name: data
              mountPath: /home/node/.openclaw
            - name: secret-anthropic
              mountPath: /etc/secrets/anthropic
              readOnly: true
            - name: secret-gateway
              mountPath: /etc/secrets/gateway
              readOnly: true
            - name: secret-openai
              mountPath: /etc/secrets/openai
              readOnly: true
            - name: secret-gemini
              mountPath: /etc/secrets/gemini
              readOnly: true
          resources:
            requests:
              cpu: 100m
              memory: 256Mi
            limits:
              cpu: "1"
              memory: 1Gi
          readinessProbe:
            httpGet:
              path: /health
              port: gateway
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            httpGet:
              path: /health
              port: gateway
            initialDelaySeconds: 15
            periodSeconds: 30
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: openclaw-data
        - name: config
          configMap:
            name: openclaw-config
        - name: secret-anthropic
          secret:
            secretName: anthropic-api-key
        - name: secret-gateway
          secret:
            secretName: openclaw-gateway-token
        - name: secret-openai
          secret:
            secretName: openai-api-key
            optional: true
        - name: secret-gemini
          secret:
            secretName: gemini-api-key
            optional: true
```

Note that all `secretName` references point to the **original** secret names. Kloak's webhook automatically rewrites references to kloak-enabled secrets to the shadow secrets (e.g., `anthropic-api-key` becomes `anthropic-api-key-kloak`). The gateway token is not kloak-enabled, so its reference is left unchanged.

```bash
kubectl apply -f openclaw-deployment.yaml
```

## Step 6: Expose the Gateway

Create a Service for internal cluster access:

```yaml
# openclaw-service.yaml
apiVersion: v1
kind: Service
metadata:
  name: openclaw
  namespace: openclaw
spec:
  selector:
    app: openclaw
  ports:
    - port: 18789
      targetPort: gateway
      name: gateway
```

```bash
kubectl apply -f openclaw-service.yaml
```

For local development, port-forward to access the gateway:

```bash
kubectl port-forward -n openclaw svc/openclaw 18789:18789
```

## Step 7: Verify Kloak Protection

### Check the Pod Was Mutated

Verify Kloak's webhook rewrote the secret references:

```bash
kubectl get pod -l app=openclaw -n openclaw -o jsonpath='{.items[0].metadata.annotations}' | jq .
```

You should see `getkloak.io/enabled: "true"` in the annotations.

### Check What the App Sees

Exec into the pod and inspect the mounted secret files:

```bash
kubectl exec -n openclaw deploy/openclaw -- cat /etc/secrets/anthropic/ANTHROPIC_API_KEY
```

```
kl::40u&8,CJZW0s0cc0iaea2i0c1oit0te
```

The application only sees `kl::` placeholders (random characters, same length as your real key) -- the real keys are never in process memory.

### Check Controller Logs

Verify the eBPF uprobes were attached and secrets synced:

```bash
kubectl logs -n kloak-system -l app.kubernetes.io/component=controller --tail=200 | grep -i "attached TLS uprobes"
```

You should see `Successfully attached TLS uprobes` for the OpenClaw process. Per-secret sync events (`synced secret into eBPF map`, with `hostLen > 0` confirming host filtering is active) are logged only at trace level -- install with `--set log.level=trace` to see them.

### Test an API Call

Use OpenClaw to make a real API call and verify it works:

```bash
# Port-forward if not already done
kubectl port-forward -n openclaw svc/openclaw 18789:18789 &

# Send a test message (use the gateway token from gateway-token-secret.yaml)
curl -s http://localhost:18789/api/v1/chat \
  -H "Authorization: Bearer your-long-random-gateway-token-here" \
  -H "Content-Type: application/json" \
  -d '{"message": "Say hello in one sentence.", "model": "claude-sonnet-4-20250514"}' | jq .
```

If you get a successful response from Claude, Kloak is working -- the `kl::` placeholder was transparently replaced with your real Anthropic API key in-kernel, in the encrypted TLS traffic as it left the pod.

## How Host Filtering Protects You

The security power of this setup comes from per-secret host filtering. Here is what happens for each API key:

| Secret | Allowed Host | What Happens |
|---|---|---|
| `anthropic-api-key` | `api.anthropic.com` | Key is rewritten only for TLS connections to Anthropic |
| `openai-api-key` | `api.openai.com` | Key is rewritten only for TLS connections to OpenAI |
| `gemini-api-key` | `generativelanguage.googleapis.com` | Key is rewritten only for TLS connections to Google |
| `openclaw-gateway-token` | *(not Kloak-managed)* | Plain Secret; verified locally by OpenClaw, never rewritten |

**Attack scenario prevented:** If an attacker exploits a vulnerability in OpenClaw (e.g., prompt injection leading to SSRF), they could try to make OpenClaw send API keys to `evil.attacker.com`. With Kloak's host filtering:

1. The attacker triggers a request to `evil.attacker.com` carrying the Anthropic key placeholder
2. Kloak's eBPF program resolves the destination via the DNS-verified trust chain
3. `evil.attacker.com` does not match `api.anthropic.com`
4. The placeholder is **not** rewritten -- the attacker receives `kl::40u&8,CJZ...` (useless)

## Troubleshooting

### OpenClaw Fails to Start

Check if the shadow secrets exist:

```bash
kubectl get secrets -n openclaw | grep kloak
```

If missing, verify the original secrets have the `getkloak.io/enabled=true` label (and that `getkloak.io/hosts` is an annotation, not a label):

```bash
kubectl get secret anthropic-api-key -n openclaw --show-labels
```

### API Calls Return Authentication Errors

1. **Check controller logs** for eBPF attachment:
   ```bash
   kubectl logs -n kloak-system -l app.kubernetes.io/component=controller --tail=100
   ```

2. **Verify DNS capture** is working (eBPF debug counters are logged only at trace level, `--set log.level=trace`):
   ```bash
   kubectl logs -n kloak-system -l app.kubernetes.io/component=controller | grep -i "dns"
   ```

3. **Check the host filter** matches the actual API endpoint. For example, if Anthropic changes their API domain, the host filter would block the rewrite. Verify with:
   ```bash
   kubectl exec -n openclaw deploy/openclaw -- nslookup api.anthropic.com
   ```

### Gateway Token Not Working

The gateway token is verified locally by OpenClaw, so it must **not** be Kloak-managed. If clients cannot authenticate, check that the original secret was mounted, not a shadow:

```bash
kubectl get pod -l app=openclaw -n openclaw \
  -o jsonpath='{.items[0].spec.volumes}' | jq '.[] | select(.name == "secret-gateway")'
```

The `secret.secretName` should be `openclaw-gateway-token` with no `-kloak` suffix. If it has the suffix, remove the `getkloak.io/enabled` label from the secret and recreate the pod.

## Clean Up

```bash
kubectl delete namespace openclaw
```

## Next Steps

- Read the [Host Filtering guide](/guides/host-filtering) to understand the DNS-verified trust chain in depth
- Learn about [Supported Runtimes](/guides/supported-runtimes) -- OpenClaw runs on Node.js, which uses the OpenSSL bundled in the `node` binary; Kloak supports it
- Review the [Architecture Overview](/architecture/overview) for the full eBPF data flow
