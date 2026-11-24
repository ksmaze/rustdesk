# RustDesk web client in Docker, with peer-to-peer over WireGuard

The `Dockerfile.web` image serves the Flutter web client and runs `rustdesk-web-gateway`
(`docker/web/gateway`). The remote side is a stock RustDesk install. It needs no custom build.

## Why there is a gateway

A browser can only open WebSocket/WebRTC connections. It cannot speak WireGuard (UDP) or reach
RustDesk's direct IP access port (TCP 21118). The gateway terminates the tunnel inside the
container. For each session it accepts the web client's WebSocket and dials `host:21118`. Each
WebSocket message becomes one RustDesk `BytesCodec` frame and back, which is the same conversion
`hbbr` does between web and native peers.

```
browser ──ws://localhost:5000/ws/direct/10.66.0.1:21118──▶ gateway ══WireGuard══▶ RustDesk host :21118
```

Connecting by ID is unchanged. It goes through your rendezvous and relay servers (`RUSTDESK_SERVER`
and the rest). To go peer-to-peer, type the host's tunnel IP (e.g. `10.66.0.1`) in the web client.

## Remote side: Windows with stock RustDesk

1. Install RustDesk. In **Settings → Security**, turn on **Enable direct IP access** (port 21118),
   and set a permanent password.
2. Optional: turn on **Use IP whitelisting** and add the tunnel subnet (e.g. `10.66.0.0/24`).
3. Set up a tunnel (one of the modes below). Windows Firewall must allow inbound TCP 21118 on the
   tunnel interface, and UDP 51820 too in plain WireGuard mode.

The direct connection skips RustDesk's own key exchange, just as native direct IP connections do.
WireGuard or Tailscale encrypts and authenticates it instead, so only use direct access over a
tunnel or a trusted LAN.

## Tunnel modes

The gateway picks one mode at startup.

| Mode | Enable with | Reaches | Remote side runs |
| --- | --- | --- | --- |
| WireGuard | mount `/etc/wireguard/wg0.conf` (or set `WG_CONFIG`) | LAN, or internet when the host's UDP port is reachable (public IP / port forward / IPv6) | WireGuard for Windows |
| Tailscale / Headscale | `TS_AUTHKEY` (or `TS_ENABLE=true` and log in via the URL in the logs); `TS_LOGIN_SERVER` for Headscale | Anywhere: NAT traversal, DERP relay fallback | Tailscale for Windows |
| None | default | LAN, or a VPN running on the Mac itself | nothing |

All modes run in user space inside the gateway process, so the container needs no `NET_ADMIN` or
`/dev/net/tun`. This works the same on Docker Desktop for macOS.

The gateway only dials port 21118 (`GATEWAY_ALLOW_PORTS`), and only inside the tunnel's networks
by default. Those are the WireGuard peers' `AllowedIPs`, Tailscale's `100.64.0.0/10`, or the private
ranges with no tunnel. Override them with `GATEWAY_ALLOW_CIDRS` (comma separated, or `any`). The
WebSocket only accepts same-origin pages, but anyone who can reach the published port can still
use the gateway. Publish it on `127.0.0.1` unless you mean to share it.

### WireGuard

Generate a matching pair of configs. The endpoint is the address the Mac reaches Windows at: its
LAN IP, or a public IP / DDNS name with UDP 51820 forwarded to it.

```sh
docker run --rm -v "$PWD/wg:/out" rr-web:arm wg-pair -endpoint my-home.ddns.net
```

- Import `wg/windows.conf` into WireGuard for Windows and activate it. The host gets `10.66.0.1`.
- Run the web client with `wg/wg0.conf`:

  ```sh
  docker run -d --name rustdesk-web -p 127.0.0.1:5000:5000 \
    -v "$PWD/wg/wg0.conf:/etc/wireguard/wg0.conf:ro" rr-web:arm
  ```

Open http://localhost:5000 and connect to `10.66.0.1`. The container dials out and keeps the NAT
mapping open (`PersistentKeepalive`), so only the Windows side needs to be reachable. The
gateway re-resolves DDNS endpoints every 2 minutes.

### Tailscale / Headscale

Use this mode when neither side can accept inbound UDP, e.g. both are behind NAT or CGNAT.

```sh
docker run -d --name rustdesk-web -p 127.0.0.1:5000:5000 \
  -v rustdesk-web:/var/lib/rustdesk-web \
  -e TS_AUTHKEY=tskey-auth-... [-e TS_LOGIN_SERVER=https://headscale.example.com] rr-web:arm
```

Connect to the Windows machine's `100.x.y.z` address. `tailscale status` on Windows shows whether
the path is `direct` or relayed through DERP. Docker Desktop adds its own NAT layer, which can
make a direct path harder to get. If you only ever see DERP, run Tailscale on the Mac itself and
start the container in the default mode. It then dials `100.x.y.z` through the Mac's tunnel.

## Building

CI (`.github/workflows/web-docker.yml`) builds `rr-web:arm` for `linux/arm64` (Apple silicon)
and uploads it as the `rr-web-arm.tar` artifact. Load it with `docker load -i rr-web-arm.tar`.
Locally: `docker build -f Dockerfile.web -t rr-web:arm .`
