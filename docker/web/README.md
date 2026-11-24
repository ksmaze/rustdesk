# RustDesk web client in Docker, with peer-to-peer over WireGuard

The `Dockerfile.web` image serves the Flutter web client and runs `rustdesk-web-gateway`
(`docker/web/gateway`). The remote side is a released app, with no custom build:

- **[SealDesk](https://github.com/runseal-labs/sealdesk)** (recommended): paste its pairing code.
  This works across any NAT with nothing to configure.
- **Stock RustDesk**: type its IP. You need a LAN, or a WireGuard tunnel you set up yourself.

## Why there is a gateway

A browser can only open WebSocket/WebRTC connections. It cannot speak WireGuard (UDP) or reach
RustDesk's session port (TCP 21118). The gateway terminates the tunnel inside the container. For
each session it accepts the web client's WebSocket and opens a stream to the host. Each WebSocket
message becomes one RustDesk `BytesCodec` frame and back, which is the same conversion `hbbr` does
between web and native peers.

```
browser ──ws://localhost:5000/ws/tailcat/tc...──────────▶ gateway ══tailcat (WireGuard)══▶ SealDesk host
browser ──ws://localhost:5000/ws/direct/10.66.0.1:21118──▶ gateway ══WireGuard / LAN═════▶ RustDesk host :21118
```

Connecting by ID is unchanged. It goes through your rendezvous and relay servers (`RUSTDESK_SERVER`
and the rest).

## SealDesk host (recommended)

1. Install SealDesk on Windows and tap **Share this device**.
2. Run the web client. The volume keeps the gateway's controller identity, so a host can
   trust it across restarts.

   ```sh
   docker run -d --name rustdesk-web -p 127.0.0.1:5000:5000 \
     -v rustdesk-web:/var/lib/rustdesk-web rr-web:arm
   ```

3. Open http://localhost:5000. Instead of scanning the QR code, paste the pairing code into the
   ID box: the `SEALDESK:V:1;A:tc...;;` text shown under the QR code, or printed by
   `sealdesk --tc-pair`. A bare `tc...` address works too, and then you type the password.

SealDesk's tailcat transport is WireGuard with Tailscale's NAT traversal. Both sides punch a direct
UDP path when they can. Otherwise a public DERP relay forwards packets it cannot decrypt. Neither
side needs a forwarded port, an account, or a server you run. If the pairing code carries a
temporary password, the web client logs in with it. A code without one, from a host that only
accepts by click, waits for the host to approve.

If the host uses an allow list (`sealdesk --tc-allow`), add the gateway's controller key. The
gateway logs it at startup as `SealDesk controller identity: nodekey:...`.

## Stock RustDesk host: Windows

1. Install RustDesk. In **Settings → Security**, turn on **Enable direct IP access** (port 21118),
   and set a permanent password.
2. Optional: turn on **Use IP whitelisting** and add the tunnel subnet (e.g. `10.66.0.0/24`).
3. Set up a tunnel (one of the modes below). Windows Firewall must allow inbound TCP 21118 on the
   tunnel interface, and UDP 51820 too in WireGuard mode.

The direct connection skips RustDesk's own key exchange, just as native direct IP connections do.
WireGuard encrypts and authenticates it instead, so only use direct access over a
tunnel or a trusted LAN.

## Tunnel modes

For direct IP connections, the gateway picks one mode at startup.

| Mode | Enable with | Reaches | Remote side runs |
| --- | --- | --- | --- |
| WireGuard | mount `/etc/wireguard/wg0.conf` (or set `WG_CONFIG`) | LAN, or internet when the host's UDP port is reachable (public IP / port forward / IPv6) | WireGuard for Windows |
| None | default | LAN, or a VPN running on the Mac itself (e.g. Tailscale) | nothing |

Both modes, and tailcat, run in user space inside the gateway process. The container needs no
`NET_ADMIN` or `/dev/net/tun`, so this works the same on Docker Desktop for macOS.

The gateway only dials port 21118 (`GATEWAY_ALLOW_PORTS`), and only inside the tunnel's networks
by default. Those are the WireGuard peers' `AllowedIPs`, or the private ranges with no tunnel. Override them with `GATEWAY_ALLOW_CIDRS` (comma separated, or `any`). The
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

## Building

CI (`.github/workflows/web-docker.yml`) builds `rr-web:arm` for `linux/arm64` (Apple silicon)
and uploads it as the `rr-web-arm.tar` artifact. Load it with `docker load -i rr-web-arm.tar`.
Locally: `docker build -f Dockerfile.web -t rr-web:arm .`
