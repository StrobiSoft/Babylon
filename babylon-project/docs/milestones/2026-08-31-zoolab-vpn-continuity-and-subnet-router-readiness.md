# Milestone — ZooLab VPN continuity and subnet-router recovery readiness

**Date:** 2026-08-31

## Summary

The new Noemi CT105 Codex workstation can now authenticate non-interactively to the Pepper Proxmox host and perform controlled read-only infrastructure inspection. Using that access path, CT104 was verified as the running ZooLab Tailscale subnet-router container.

This milestone records verified infrastructure reachability and recovery knowledge. It does not claim production-hardening completion or full remote-path acceptance testing.

## Verified access chain

```text
CT105 (noemi, 192.168.1.93)
  -> SSH with dedicated Ed25519 identity
Pepper (192.168.1.188)
  -> Proxmox pct
CT104 (zoolab-vpn-01)
```

Verified:

- CT105 -> Pepper SSH authentication: PASS;
- Pepper hostname: `pepper`;
- Pepper Proxmox: `pve-manager/9.2.5/20242970da7fbcef`;
- Pepper kernel: `7.0.14-6-pve`;
- CT104 status: `running`.

The CT105 public key installed for Pepper access is source-restricted to `192.168.1.93` and disables agent forwarding, port forwarding, X11 forwarding and PTY allocation. No private key material is stored in this repository.

## CT104 verified identity

- Proxmox container: CT104
- hostname: `zoolab-vpn-01`
- OS: Debian GNU/Linux 13 (trixie)
- architecture: amd64
- unprivileged LXC
- autostart: enabled
- resources: 1 CPU, 512 MiB RAM, 256 MiB swap
- LXC features: `keyctl=1,nesting=1`
- LAN interface: `eth0`
- LAN IPv4: `192.168.1.89/24`
- IPv4 default gateway: `192.168.1.254`

## VPN technology and role

Verified technology: **Tailscale**.

Verified runtime facts:

- Tailscale version: `1.102.3`;
- interface: `tailscale0`;
- Tailscale IPv4: `100.85.201.120/32`;
- Tailscale IPv6: `fd7a:115c:a1e0::bb01:c9cb/128`;
- `tailscaled.service`: enabled, active, running;
- backend state: Running;
- TUN: active;
- online: true;
- health issue count: 0;
- Tailscale SSH: disabled;
- no exit node is selected and CT104 does not advertise itself as an exit node;
- control plane: `https://controlplane.tailscale.com`;
- preferred DERP region observed: `ams`.

CT104 advertises four /32 LAN routes:

- `192.168.1.72/32`
- `192.168.1.83/32`
- `192.168.1.90/32`
- `192.168.1.188/32` (Pepper)

The runtime state is consistent with a Tailscale subnet-router: forwarding and post-routing MASQUERADE rules are present, `NoSNAT=False`, and Tailscale policy routing uses table 52.

Observed topology:

```text
Tailscale peer
  -> tailscale0 / CT104
  -> forwarding + SNAT/MASQUERADE
  -> eth0 / 192.168.1.0/24
  -> advertised /32 LAN targets
```

A real remote-peer end-to-end validation is still required before claiming full-path acceptance.

## Safe configuration locations

The following paths were identified without reading secret-bearing state contents:

- systemd unit: `/usr/lib/systemd/system/tailscaled.service`
- environment file: `/etc/default/tailscaled`
- state directory: `/var/lib/tailscale`
- local state: `/var/lib/tailscale/tailscaled.state`
- profile state: `/var/lib/tailscale/profile-data/`
- DERP cache: `/var/lib/tailscale/derpmap.cached.json`
- log configuration: `/var/lib/tailscale/tailscaled.log.conf`

The state/profile locations may contain authentication-sensitive material and must not be copied into repository documentation.

A local candidate file was also observed:

`/root/zoolab-vpn-guard-candidate-20260829-155419.nft`

Only metadata was inspected. Its operational status is not yet verified; it may be active, planned or stale.

## Security posture of this inspection

The inspection was intentionally read-only:

- no private SSH key was printed;
- no Tailscale state/profile/auth/token contents were read;
- no password, token, private key, preshared key or MFA data was exposed;
- no SSH, Proxmox, container, network, firewall, Tailscale or repository configuration was modified during reconnaissance.

## Remaining acceptance criteria

Before this milestone can be treated as full VPN recovery readiness, complete and document:

1. end-to-end reachability from a real remote Tailscale peer to all four advertised LAN targets;
2. authoritative Tailscale ACL and route-approval ownership/process;
3. CT104 restart/reboot validation;
4. state backup / re-enrollment recovery procedure without storing secrets in Git;
5. monitoring and alerting expectations;
6. the authoritative status of the `.nft` candidate file.

## Relationship to continuity work

This access path materially strengthens the NOEMI continuity model: CT105 can now reach Pepper and inspect CT104 using a bounded, auditable automation path. The authoritative infrastructure specification should live in ZooLab Infrastructure Docs; Babylon continuity records should reference it rather than duplicate sensitive operational configuration.
