#!/usr/bin/env python3
import os
import sys
import time
import socket
import subprocess
import pexpect

HOST = os.environ.get('BANANA_HOST', '192.168.1.6')
USER = os.environ.get('BANANA_USER', 'root')
PASSWORD = os.environ.get('BANANA_PASS', 'navid')
PORT = 18789
REMOTE_DIR = '/opt/se-aiproxy'
LEGACY_REMOTE_DIR = '/opt/deepseek-codex-proxy'
LOCAL_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
LOCAL_TAR = '/tmp/banana-deploy.tar.gz'

def log(msg):
    print(f"[*] {msg}", flush=True)

def error(msg):
    print(f"[-] ERROR: {msg}", flush=True)

def success(msg):
    print(f"[+] SUCCESS: {msg}", flush=True)

def run_remote(cmd, timeout=90):
    ssh_cmd = f"ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null {USER}@{HOST} {cmd!r}"
    child = pexpect.spawn(ssh_cmd, timeout=timeout, encoding='utf-8')
    try:
        while True:
            idx = child.expect(['(?i)password:', 'yes/no', pexpect.EOF, pexpect.TIMEOUT])
            if idx == 0:
                child.sendline(PASSWORD)
            elif idx == 1:
                child.sendline('yes')
            elif idx == 2:
                break
            elif idx == 3:
                child.close()
                raise TimeoutError(f"Command timed out after {timeout}s: {cmd}")
    except Exception as e:
        child.close()
        raise e
    child.close()
    return child.before, child.exitstatus

def scp_file(local_path, remote_path, timeout=60):
    scp_cmd = f"scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null {local_path!r} {USER}@{HOST}:{remote_path!r}"
    child = pexpect.spawn(scp_cmd, timeout=timeout, encoding='utf-8')
    try:
        while True:
            idx = child.expect(['(?i)password:', 'yes/no', pexpect.EOF, pexpect.TIMEOUT])
            if idx == 0:
                child.sendline(PASSWORD)
            elif idx == 1:
                child.sendline('yes')
            elif idx == 2:
                break
            elif idx == 3:
                child.close()
                raise TimeoutError(f"SCP timed out after {timeout}s for {local_path}")
    except Exception as e:
        child.close()
        raise e
    child.close()
    if child.exitstatus != 0:
        raise RuntimeError(f"SCP failed with exit code {child.exitstatus}")

def is_port_open(host, port, timeout=2.0):
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(timeout)
        res = s.connect_ex((host, port))
        s.close()
        return res == 0
    except:
        return False

def deploy():
    log(f"Connecting to Banana Pi at {HOST}...")
    if not is_port_open(HOST, 22, timeout=2.0):
        error(f"Cannot connect to {HOST}:22 (SSH).")
        return False

    success(f"SSH port 22 is reachable on {HOST}!")

    log("Creating self-contained deployment bundle (source + dependencies + active config)...")
    if os.path.exists(LOCAL_TAR):
        os.remove(LOCAL_TAR)

    tar_cmd = f"cd {LOCAL_ROOT!r} && tar -czf {LOCAL_TAR!r} --exclude='data/config.json' --exclude='node_modules' src public package.json"
    subprocess.check_call(tar_cmd, shell=True)
    tar_size_mb = os.path.getsize(LOCAL_TAR) / (1024 * 1024)
    log(f"Bundle created: {tar_size_mb:.2f} MB")

    log("Uploading deployment bundle to Banana Pi...")
    scp_file(LOCAL_TAR, "/tmp/banana-deploy.tar.gz")

    # Older versions ("Codex Proxy") lived in /opt/deepseek-codex-proxy as the "deepseek-proxy" service:
    # stop it and move its folder (accounts, keys, node_modules) to the new place
    log("Retiring the old deepseek-proxy service if present...")
    run_remote(f"systemctl disable --now deepseek-proxy 2>/dev/null; rm -f /etc/systemd/system/deepseek-proxy.service; "
               f"if [ -d {LEGACY_REMOTE_DIR} ] && [ ! -d {REMOTE_DIR} ]; then mv {LEGACY_REMOTE_DIR} {REMOTE_DIR}; fi")

    log(f"Extracting package to {REMOTE_DIR}...")
    run_remote(f"mkdir -p {REMOTE_DIR} && tar -xzf /tmp/banana-deploy.tar.gz -C {REMOTE_DIR}/ && rm -f /tmp/banana-deploy.tar.gz")

    node_path = "/usr/bin/node"

    # Create systemd service
    service_content = f"""[Unit]
Description=SE-AiProxy (shirazelectronic.ir)
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory={REMOTE_DIR}
ExecStart={node_path} {REMOTE_DIR}/src/server.js
Restart=always
RestartSec=5
Environment=PORT=18789
Environment=HOST=0.0.0.0

[Install]
WantedBy=multi-user.target
"""
    log("Installing systemd service (/etc/systemd/system/se-aiproxy.service)...")
    service_file = "/etc/systemd/system/se-aiproxy.service"
    run_remote(f"cat << 'EOF' > {service_file}\n{service_content}\nEOF")

    log("Enabling and starting se-aiproxy systemd service...")
    run_remote("systemctl daemon-reload && systemctl enable se-aiproxy && systemctl restart se-aiproxy --no-block")

    log("Waiting up to 15s for service initialization...")
    is_live = False
    for i in range(15):
        time.sleep(1)
        if is_port_open(HOST, PORT, timeout=1.0):
            try:
                local_check = subprocess.check_output(['curl', '-s', f'http://{HOST}:{PORT}/health'], timeout=3).decode('utf-8')
                if '"status":"ok"' in local_check:
                    is_live = True
                    break
            except:
                pass

    log("Verifying service status on Banana Pi...")
    status_out, _ = run_remote("systemctl status se-aiproxy --no-pager | head -n 15")
    log("Service status:\n" + status_out.strip())

    health_out, _ = run_remote("curl -s http://127.0.0.1:18789/health || echo 'HEALTH_FAILED'")
    log(f"Remote Health Check: {health_out.strip()}")

    if is_live:
        success(f"Proxy is LIVE across LAN! Response: {health_out.strip()}")
        print("\n========================================================")
        print(f"  🎉 SE-AiProxy is permanently running on Banana Pi!")
        print(f"  🌐 Web Dashboard: http://{HOST}:{PORT}")
        print(f"  🔗 API Base URL:  http://{HOST}:{PORT}/v1")
        print("========================================================\n")
        return True
    else:
        error("Service failed to become ready within timeout.")
        return False
        error(f"Port {PORT} is not open on {HOST}.")
        return False

if __name__ == '__main__':
    ok = deploy()
    sys.exit(0 if ok else 1)
