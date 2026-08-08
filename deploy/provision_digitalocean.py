#!/usr/bin/env python3
"""One-time DigitalOcean provisioning for the odds radar."""

from __future__ import annotations

import argparse
import base64
import json
import subprocess
import time
from pathlib import Path

API = "https://api.digitalocean.com/v2"


def request(method: str, path: str, **kwargs):
    command = [
        "curl",
        "--max-time",
        "60",
        "--fail-with-body",
        "--silent",
        "--show-error",
        "--request",
        method,
        f"{API}{path}",
    ]
    payload = None
    if "json" in kwargs:
        command.extend(["--header", "content-type: application/json", "--data-binary", "@-"])
        payload = json.dumps(kwargs["json"]).encode()
    process = subprocess.run(command, input=payload, capture_output=True)
    if process.returncode:
        raise RuntimeError(
            f"DigitalOcean {method} {path} failed: {process.stderr.decode()[:500]}"
            f"{process.stdout.decode()[:500]}"
        )
    return json.loads(process.stdout) if process.stdout else {}


def b64(path: Path) -> str:
    return base64.b64encode(path.read_bytes()).decode()


def cloud_init(admin_public_key: str, repo_key: Path, password: str, repository: str) -> str:
    env = f"""RADAR_ACCESS_USER=radar
RADAR_ACCESS_PASSWORD={password}
RADAR_AUTO_SCAN=0
RADAR_HOURLY_PREWARM=0
RADAR_BOOTSTRAP=0
RADAR_SCAN_WINDOW_MIN=30
RADAR_SCAN_INTERVAL_SEC=30
RADAR_SIM_TARGET=0
RADAR_DEMO=0
PINNAPI_API_KEY=
PINNAPI_BASE_URL=https://pinnapi.com
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
PINNACLE_TITAN_COMPANY_ID=47
"""
    return f"""#cloud-config
users:
  - default
  - name: radar
    groups: [sudo]
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    ssh_authorized_keys:
      - {admin_public_key}
write_files:
  - path: /tmp/odds-radar-repo-key
    permissions: '0600'
    encoding: b64
    content: {b64(repo_key)}
  - path: /tmp/odds-radar.env
    permissions: '0600'
    encoding: b64
    content: {base64.b64encode(env.encode()).decode()}
runcmd:
  - install -m 0755 -d /home/radar/.ssh
  - mv /tmp/odds-radar-repo-key /home/radar/.ssh/id_ed25519
  - ssh-keyscan -H github.com > /home/radar/.ssh/known_hosts
  - chown -R radar:radar /home/radar/.ssh
  - apt-get update
  - apt-get install -y ca-certificates curl git
  - install -m 0755 -d /etc/apt/keyrings
  - curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  - chmod a+r /etc/apt/keyrings/docker.asc
  - 'echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" > /etc/apt/sources.list.d/docker.list'
  - apt-get update
  - apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  - usermod -aG docker radar
  - install -d -o radar -g radar /opt/odds-radar
  - 'sudo -u radar git clone git@github.com:{repository}.git /opt/odds-radar'
  - mv /tmp/odds-radar.env /opt/odds-radar/.env
  - chown radar:radar /opt/odds-radar/.env
  - install -d -o radar -g radar /opt/odds-radar/data /opt/odds-radar/backups
  - 'cd /opt/odds-radar && docker compose up -d --build'
"""


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--admin-public-key", type=Path, required=True)
    parser.add_argument("--repo-private-key", type=Path, required=True)
    parser.add_argument("--dashboard-password-file", type=Path, required=True)
    parser.add_argument("--repository", required=True)
    args = parser.parse_args()

    admin_public_key = args.admin_public_key.read_text().strip()
    key_name = "odds-radar-github-actions"
    keys = request("GET", "/account/keys?per_page=200").get("ssh_keys", [])
    key = next((item for item in keys if item.get("name") == key_name), None)
    if key is None:
        key = request("POST", "/account/keys", json={"name": key_name, "public_key": admin_public_key})["ssh_key"]

    existing = request("GET", "/droplets?tag_name=odds-radar&per_page=100").get("droplets", [])
    if existing:
        droplet = existing[0]
    else:
        payload = {
            "name": "odds-radar-sgp1",
            "region": "sgp1",
            "size": "s-1vcpu-1gb",
            "image": "ubuntu-24-04-x64",
            "ssh_keys": [key["id"]],
            "backups": False,
            "ipv6": True,
            "monitoring": True,
            "tags": ["odds-radar"],
            "user_data": cloud_init(
                admin_public_key,
                args.repo_private_key,
                args.dashboard_password_file.read_text().strip(),
                args.repository,
            ),
        }
        droplet = request("POST", "/droplets", json=payload)["droplet"]

    droplet_id = droplet["id"]
    ip = None
    for _ in range(60):
        droplet = request("GET", f"/droplets/{droplet_id}")["droplet"]
        networks = droplet.get("networks", {}).get("v4", [])
        ip = next((item["ip_address"] for item in networks if item.get("type") == "public"), None)
        if droplet.get("status") == "active" and ip:
            break
        time.sleep(5)
    if not ip:
        raise RuntimeError("Droplet did not receive a public IPv4 address in time")

    firewalls = request("GET", "/firewalls?per_page=200").get("firewalls", [])
    if not any(item.get("name") == "odds-radar-web" for item in firewalls):
        request(
            "POST",
            "/firewalls",
            json={
                "name": "odds-radar-web",
                "tags": ["odds-radar"],
                "inbound_rules": [
                    {
                        "protocol": "tcp",
                        "ports": "22",
                        "sources": {"addresses": ["0.0.0.0/0", "::/0"]},
                    },
                    {
                        "protocol": "tcp",
                        "ports": "80",
                        "sources": {"addresses": ["0.0.0.0/0", "::/0"]},
                    },
                ],
                "outbound_rules": [
                    {
                        "protocol": "tcp",
                        "ports": "all",
                        "destinations": {"addresses": ["0.0.0.0/0", "::/0"]},
                    },
                    {
                        "protocol": "udp",
                        "ports": "all",
                        "destinations": {"addresses": ["0.0.0.0/0", "::/0"]},
                    },
                    {
                        "protocol": "icmp",
                        "destinations": {"addresses": ["0.0.0.0/0", "::/0"]},
                    },
                ],
            },
        )

    print(
        json.dumps(
            {
                "droplet_id": droplet_id,
                "name": droplet["name"],
                "status": droplet["status"],
                "ip": ip,
                "region": droplet["region"]["slug"],
                "size": droplet["size_slug"],
            }
        )
    )


if __name__ == "__main__":
    main()
