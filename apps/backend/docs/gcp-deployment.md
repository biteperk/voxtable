# VocoTable — Google Cloud VM Deployment Guide

> **Last updated:** May 2026
>
> This guide walks through deploying the VocoTable backend + PostgreSQL stack to a single Google Cloud Compute Engine VM with Docker Compose, Nginx reverse proxy, and Let's Encrypt SSL.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Step 1: Create the VM](#step-1-create-the-vm)
3. [Step 2: Firewall Rules](#step-2-firewall-rules)
4. [Step 3: Reserve a Static IP](#step-3-reserve-a-static-ip)
5. [Step 4: SSH and Install Docker](#step-4-ssh-and-install-docker)
6. [Step 5: Clone and Configure](#step-5-clone-and-configure)
7. [Step 6: Start the Stack](#step-6-start-the-stack)
8. [Step 7: Install Nginx](#step-7-install-nginx)
9. [Step 8: SSL with Certbot](#step-8-ssl-with-certbot)
10. [Step 9: DNS Configuration](#step-9-dns-configuration)
11. [Step 10: Verify Deployment](#step-10-verify-deployment)
12. [Step 11: Setup Backups](#step-11-setup-backups)
13. [Step 12: Setup Health Checks](#step-12-setup-health-checks)
14. [Step 13: Update Webhook URLs](#step-13-update-webhook-urls)
15. [Common Operations](#common-operations)
16. [Troubleshooting](#troubleshooting)

---

## Prerequisites

Before starting, ensure you have:

- [ ] A **Google Cloud account** with billing enabled
- [ ] A **domain name** (e.g. `vocotable.com`) with DNS access
- [ ] **gcloud CLI** installed on your local machine ([Install Guide](https://cloud.google.com/sdk/docs/install))
- [ ] A **GCP project** created (we'll use `vocotable` as the project ID)
- [ ] Git installed locally
- [ ] The VocoTable repo cloned locally

### Authenticate gcloud

```bash
# Login to your Google Cloud account
gcloud auth login

# Set the project
gcloud config set project vocotable

# Verify
gcloud config list
```

---

## Step 1: Create the VM

Create a Compute Engine instance with Ubuntu 22.04 LTS.

```bash
gcloud compute instances create vocotable-api \
    --project=vocotable \
    --zone=australia-southeast1-b \
    --machine-type=e2-small \
    --boot-disk-size=20GB \
    --boot-disk-type=pd-ssd \
    --image-family=ubuntu-2204-lts \
    --image-project=ubuntu-os-cloud \
    --tags=http-server,https-server \
    --metadata=startup-script='#!/bin/bash
        apt-get update
        apt-get install -y ca-certificates curl gnupg'
```

**What this does:**

| Parameter | Value | Reason |
|-----------|-------|--------|
| `--zone` | `australia-southeast1-b` | Sydney region, closest to target users |
| `--machine-type` | `e2-small` | 2 vCPU, 2 GB RAM — sufficient for Phase 1 |
| `--boot-disk-size` | `20GB` | Enough for OS + Docker images + DB data |
| `--boot-disk-type` | `pd-ssd` | SSD for better Postgres I/O |
| `--tags` | `http-server,https-server` | Used by firewall rules |

> **💡 Tip:** You can upgrade the machine type later with:
> ```bash
> gcloud compute instances stop vocotable-api --zone=australia-southeast1-b
> gcloud compute instances set-machine-type vocotable-api \
>     --zone=australia-southeast1-b --machine-type=e2-medium
> gcloud compute instances start vocotable-api --zone=australia-southeast1-b
> ```

---

## Step 2: Firewall Rules

Allow HTTP (80), HTTPS (443), and SSH (22) traffic.

```bash
# Allow HTTP traffic (for Certbot ACME challenges + redirect)
gcloud compute firewall-rules create vocotable-allow-http \
    --project=vocotable \
    --direction=INGRESS \
    --priority=1000 \
    --network=default \
    --action=ALLOW \
    --rules=tcp:80 \
    --source-ranges=0.0.0.0/0 \
    --target-tags=http-server \
    --description="Allow HTTP for VocoTable (Certbot + redirect)"

# Allow HTTPS traffic
gcloud compute firewall-rules create vocotable-allow-https \
    --project=vocotable \
    --direction=INGRESS \
    --priority=1000 \
    --network=default \
    --action=ALLOW \
    --rules=tcp:443 \
    --source-ranges=0.0.0.0/0 \
    --target-tags=https-server \
    --description="Allow HTTPS for VocoTable API"
```

> **Note:** SSH (port 22) is allowed by the default GCP firewall rule `default-allow-ssh`. If you want to restrict SSH to specific IPs or use IAP tunneling instead, see [Troubleshooting](#restrict-ssh-access).

Verify the rules:

```bash
gcloud compute firewall-rules list --filter="name~vocotable"
```

---

## Step 3: Reserve a Static IP

Reserve a static external IP so the address doesn't change on VM restart.

```bash
# Reserve a static IP
gcloud compute addresses create vocotable-ip \
    --project=vocotable \
    --region=australia-southeast1 \
    --description="Static IP for VocoTable API"

# Get the reserved IP address
gcloud compute addresses describe vocotable-ip \
    --region=australia-southeast1 \
    --format="value(address)"
```

**Save this IP address** — you'll need it for DNS configuration.

```bash
# Assign the static IP to the VM
gcloud compute instances delete-access-config vocotable-api \
    --zone=australia-southeast1-b \
    --access-config-name="External NAT"

gcloud compute instances add-access-config vocotable-api \
    --zone=australia-southeast1-b \
    --access-config-name="External NAT" \
    --address=$(gcloud compute addresses describe vocotable-ip \
        --region=australia-southeast1 --format="value(address)")
```

Verify:

```bash
gcloud compute instances describe vocotable-api \
    --zone=australia-southeast1-b \
    --format="value(networkInterfaces[0].accessConfigs[0].natIP)"
```

---

## Step 4: SSH and Install Docker

### 4.1 Connect to the VM

```bash
gcloud compute ssh vocotable-api --zone=australia-southeast1-b
```

### 4.2 Update system packages

```bash
sudo apt-get update && sudo apt-get upgrade -y
```

### 4.3 Install Docker Engine

```bash
# Add Docker's official GPG key
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | \
    sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

# Add Docker repository
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# Install Docker Engine + Compose plugin
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin

# Add your user to the docker group (avoids needing sudo for docker commands)
sudo usermod -aG docker $USER
```

> **⚠️ Important:** Log out and back in for the group change to take effect:
> ```bash
> exit
> gcloud compute ssh vocotable-api --zone=australia-southeast1-b
> ```

### 4.4 Verify Docker installation

```bash
docker --version
docker compose version
docker run hello-world
```

---

## Step 5: Clone and Configure

### 5.1 Create the project directory

```bash
sudo mkdir -p /opt/vocotable
sudo chown $USER:$USER /opt/vocotable
```

### 5.2 Clone the repository

```bash
cd /opt/vocotable
git clone https://github.com/YOUR_ORG/vocotable.git .
```

> **Alternative — SCP from local machine** (if repo is private / not on GitHub yet):
> ```bash
> # Run this on your LOCAL machine, not the VM
> gcloud compute scp --recurse \
>     ./vocotable/* vocotable-api:/opt/vocotable/ \
>     --zone=australia-southeast1-b
> ```

### 5.3 Create the production `.env` file

```bash
cp .env.example .env
nano .env
```

Fill in the production values:

```bash
# =============================================================================
# VocoTable Production Environment Variables
# =============================================================================

# --- Application ---
APP_ENV=production
APP_VERSION=0.1.0
PORT=3050
PUBLIC_API_BASE_URL=https://api.vocotable.com

# --- PostgreSQL (Docker Compose internal network) ---
# The hostname "postgres" matches the service name in docker-compose.yml
DATABASE_URL=postgres://vocotable:YOUR_STRONG_PASSWORD_HERE@postgres:5432/vocotable
DATABASE_SSL=false

# These are used by the postgres container to create the database
POSTGRES_USER=vocotable
POSTGRES_PASSWORD=YOUR_STRONG_PASSWORD_HERE
POSTGRES_DB=vocotable

# --- Default restaurant ---
DEFAULT_RESTAURANT_ID=11111111-1111-4111-8111-111111111111

# --- RetellAI ---
RETELL_API_KEY=key_your_production_retell_api_key
RETELL_AGENT_ID=agent_your_production_agent_id
RETELL_PHONE_NUMBER=+61XXXXXXXXX
RETELL_VERIFY_SIGNATURE=true

# --- Twilio ---
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_production_auth_token
TWILIO_PHONE_NUMBER=+61275011140
TWILIO_TERMINATION_URI=your-trunk.pstn.twilio.com
TWILIO_RETELL_SIP_URI=sip:sip.retellai.com
TWILIO_VALIDATE_SIGNATURE=true

# --- Health Check (optional) ---
HEALTH_WEBHOOK_URL=https://hooks.slack.com/services/YOUR/SLACK/WEBHOOK
```

**Environment variable reference:**

| Variable | Description | Example |
|----------|-------------|---------|
| `APP_ENV` | Runtime environment | `production` |
| `APP_VERSION` | Semantic version for `/health` | `0.1.0` |
| `PORT` | Port the Node.js API listens on | `3050` |
| `PUBLIC_API_BASE_URL` | Public-facing URL (used by webhooks) | `https://api.vocotable.com` |
| `DATABASE_URL` | Postgres connection string (Docker internal) | `postgres://vocotable:pw@postgres:5432/vocotable` |
| `DATABASE_SSL` | Enable SSL for Postgres connection | `false` (same-host Docker) |
| `POSTGRES_USER` | Postgres container superuser name | `vocotable` |
| `POSTGRES_PASSWORD` | Postgres container password | (generate a strong one) |
| `POSTGRES_DB` | Database name created on first run | `vocotable` |
| `DEFAULT_RESTAURANT_ID` | Fallback restaurant UUID | `11111111-1111-4111-8111-111111111111` |
| `RETELL_API_KEY` | RetellAI API key | `key_...` |
| `RETELL_AGENT_ID` | RetellAI agent for inbound calls | `agent_...` |
| `RETELL_PHONE_NUMBER` | Phone number registered in RetellAI | `+61...` |
| `RETELL_VERIFY_SIGNATURE` | Verify webhook signatures in prod | `true` |
| `TWILIO_ACCOUNT_SID` | Twilio Account SID | `AC...` |
| `TWILIO_AUTH_TOKEN` | Twilio Auth Token | (from Twilio console) |
| `TWILIO_PHONE_NUMBER` | Twilio phone number | `+61275011140` |
| `TWILIO_TERMINATION_URI` | SIP trunk termination URI | `your-trunk.pstn.twilio.com` |
| `TWILIO_RETELL_SIP_URI` | RetellAI SIP address | `sip:sip.retellai.com` |
| `TWILIO_VALIDATE_SIGNATURE` | Verify Twilio webhook signatures | `true` |
| `HEALTH_WEBHOOK_URL` | Slack/Discord webhook for alerts | `https://hooks.slack.com/...` |

> **🔒 Security:** Generate a strong Postgres password:
> ```bash
> openssl rand -base64 32
> ```

---

## Step 6: Start the Stack

### 6.1 Build and start all containers

```bash
cd /opt/vocotable
docker compose up -d --build
```

### 6.2 Check container status

```bash
docker compose ps
```

You should see:

```
NAME         SERVICE    STATUS    PORTS
api          api        running   0.0.0.0:3050->3050/tcp
postgres     postgres   running   5432/tcp
```

### 6.3 Run database migrations

```bash
docker compose exec api npm run db:migrate:prod
```

### 6.4 Seed the database

```bash
docker compose exec api npm run db:seed:prod
```

### 6.5 Verify the API is running

```bash
# From the VM
curl http://localhost:3050/health
```

Expected response:

```json
{
    "status": "ok",
    "database": "ok",
    "version": "0.1.0"
}
```

### 6.6 Check logs

```bash
# All services
docker compose logs -f

# Only the API
docker compose logs -f api

# Only Postgres
docker compose logs -f postgres
```

---

## Step 7: Install Nginx

### 7.1 Install Nginx

```bash
sudo apt-get install -y nginx
```

### 7.2 Copy the VocoTable config

```bash
# Remove the default site
sudo rm -f /etc/nginx/sites-enabled/default

# Copy VocoTable config
sudo cp /opt/vocotable/deploy/nginx/vocotable.conf \
    /etc/nginx/sites-available/vocotable

# Create symlink to enable it
sudo ln -sf /etc/nginx/sites-available/vocotable \
    /etc/nginx/sites-enabled/vocotable
```

### 7.3 Create the ACME challenge directory

```bash
sudo mkdir -p /var/www/certbot
```

### 7.4 Temporarily comment out the SSL server block

Before we have SSL certificates, Nginx will fail to start. We need to temporarily use HTTP only:

```bash
sudo nano /etc/nginx/sites-available/vocotable
```

Comment out the entire `server { listen 443 ... }` block (everything from the second `server {` to its closing `}`). We'll uncomment it after Certbot runs.

### 7.5 Test and start Nginx

```bash
# Test the configuration
sudo nginx -t

# Start Nginx
sudo systemctl start nginx
sudo systemctl enable nginx

# Verify
sudo systemctl status nginx
```

---

## Step 8: SSL with Certbot

### 8.1 Install Certbot

```bash
sudo apt-get install -y certbot python3-certbot-nginx
```

### 8.2 Obtain the SSL certificate

> **⚠️ Important:** DNS must already point `api.vocotable.com` to your VM's static IP before running this command. Complete [Step 9](#step-9-dns-configuration) first if you haven't already.

```bash
sudo certbot --nginx \
    -d api.vocotable.com \
    --non-interactive \
    --agree-tos \
    --email your-email@example.com \
    --redirect
```

### 8.3 Restore the full Nginx config

After Certbot succeeds, restore the full VocoTable config with the SSL block:

```bash
# Re-copy the original config (Certbot may have modified it)
sudo cp /opt/vocotable/deploy/nginx/vocotable.conf \
    /etc/nginx/sites-available/vocotable

# Test and reload
sudo nginx -t && sudo systemctl reload nginx
```

> **Note:** Certbot's `--nginx` plugin typically modifies the config automatically to add SSL directives. If you've already specified the SSL certificates in the config file (as we have), both approaches work. Just verify the final config is correct with `sudo nginx -t`.

### 8.4 Test auto-renewal

```bash
sudo certbot renew --dry-run
```

### 8.5 Verify auto-renewal timer

Certbot installs a systemd timer for automatic renewal:

```bash
sudo systemctl list-timers | grep certbot
```

Certificates renew automatically every ~60 days.

---

## Step 9: DNS Configuration

### 9.1 Get the static IP

```bash
gcloud compute addresses describe vocotable-ip \
    --region=australia-southeast1 \
    --format="value(address)"
```

### 9.2 Add DNS records

Go to your domain registrar's DNS management panel and add:

| Type | Name | Value | TTL |
|------|------|-------|-----|
| `A` | `api` | `YOUR_STATIC_IP` | 300 |

This creates `api.vocotable.com` → your VM's static IP.

### 9.3 Verify DNS propagation

```bash
# From your local machine
nslookup api.vocotable.com

# Or using dig
dig api.vocotable.com +short

# Or check from the VM
host api.vocotable.com
```

DNS propagation can take up to 48 hours, but typically completes in 5–15 minutes.

> **💡 Tip:** Lower the TTL to 300 seconds (5 min) before changes, so you can iterate quickly. Increase it to 3600+ after the setup is stable.

---

## Step 10: Verify Deployment

### 10.1 Test the health endpoint

```bash
# From your local machine
curl -v https://api.vocotable.com/health
```

Expected response:

```json
{
    "status": "ok",
    "database": "ok",
    "version": "0.1.0"
}
```

### 10.2 Verify SSL certificate

```bash
# Check SSL details
curl -vI https://api.vocotable.com 2>&1 | grep -A5 "SSL certificate"

# Or use openssl
openssl s_client -connect api.vocotable.com:443 -servername api.vocotable.com < /dev/null 2>/dev/null | openssl x509 -noout -dates
```

### 10.3 Run smoke tests

```bash
# From your local machine (set the env var to point at production)
PUBLIC_API_BASE_URL=https://api.vocotable.com npm run smoke:backend
```

### 10.4 Check container health

```bash
# SSH into the VM
gcloud compute ssh vocotable-api --zone=australia-southeast1-b

# Check all containers
docker compose ps

# Verify Postgres data persistence
docker compose down
docker compose up -d
curl http://localhost:3050/health
```

### 10.5 Security check

Verify that Postgres is NOT exposed externally:

```bash
# From your local machine — this should FAIL (timeout/refused)
nc -zv YOUR_STATIC_IP 5432
```

---

## Step 11: Setup Backups

### 11.1 Create backup directories

```bash
sudo mkdir -p /opt/vocotable/backups
sudo mkdir -p /var/log/vocotable
sudo chown $USER:$USER /opt/vocotable/backups
sudo chown $USER:$USER /var/log/vocotable
```

### 11.2 Make the backup script executable

```bash
chmod +x /opt/vocotable/deploy/scripts/backup-postgres.sh
```

### 11.3 Test a manual backup

```bash
/opt/vocotable/deploy/scripts/backup-postgres.sh
```

Verify the backup was created:

```bash
ls -la /opt/vocotable/backups/
```

### 11.4 Setup automated daily backups via cron

```bash
crontab -e
```

Add the following line (runs at 3:00 AM server time daily):

```cron
0 3 * * * /opt/vocotable/deploy/scripts/backup-postgres.sh >> /var/log/vocotable/backup-cron.log 2>&1
```

### 11.5 Restoring from a backup

To restore from a backup file:

```bash
# Decompress the backup
gunzip -k /opt/vocotable/backups/vocotable_20260524_030000.sql.gz

# Restore into the running Postgres container
cat /opt/vocotable/backups/vocotable_20260524_030000.sql | \
    docker compose exec -T postgres psql -U vocotable -d vocotable

# Clean up the decompressed file
rm /opt/vocotable/backups/vocotable_20260524_030000.sql
```

---

## Step 12: Setup Health Checks

### 12.1 Make the healthcheck script executable

```bash
chmod +x /opt/vocotable/deploy/scripts/healthcheck.sh
```

### 12.2 Test a manual health check

```bash
/opt/vocotable/deploy/scripts/healthcheck.sh
echo $?  # Should print 0
```

### 12.3 Setup automated health checks via cron

```bash
crontab -e
```

Add the following line (runs every 5 minutes):

```cron
*/5 * * * * /opt/vocotable/deploy/scripts/healthcheck.sh >> /var/log/vocotable/healthcheck-cron.log 2>&1
```

### 12.4 Full crontab (should look like this)

```cron
# VocoTable — Automated tasks
# Daily Postgres backup at 3 AM
0 3 * * * /opt/vocotable/deploy/scripts/backup-postgres.sh >> /var/log/vocotable/backup-cron.log 2>&1

# Health check every 5 minutes
*/5 * * * * /opt/vocotable/deploy/scripts/healthcheck.sh >> /var/log/vocotable/healthcheck-cron.log 2>&1
```

---

## Step 13: Update Webhook URLs

Once the API is live at `https://api.vocotable.com`, update all webhook URLs in external services.

### 13.1 RetellAI Dashboard

Go to the [RetellAI Dashboard](https://www.retellai.com/dashboard) and update:

| Setting | URL |
|---------|-----|
| Webhook URL | `https://api.vocotable.com/retell/webhook` |
| Inbound Call Webhook | `https://api.vocotable.com/retell/inbound` |
| Custom Function: `check_availability` | `https://api.vocotable.com/retell/tools/check-availability` |
| Custom Function: `create_booking` | `https://api.vocotable.com/retell/tools/create-booking` |

### 13.2 Twilio Console

Go to the [Twilio Console](https://console.twilio.com/) and update:

| Setting | URL |
|---------|-----|
| Voice Webhook (fallback) | `https://api.vocotable.com/twilio/voice` |
| Status Callback URL | `https://api.vocotable.com/twilio/status` |

### 13.3 Verify webhooks are working

Make a test phone call to the Twilio number and verify:

```bash
# Check the call appeared in call_logs
docker compose exec postgres psql -U vocotable -d vocotable \
    -c "SELECT id, provider, status, caller_phone, created_at FROM call_logs ORDER BY created_at DESC LIMIT 5;"
```

---

## Common Operations

### Viewing logs

```bash
# All services (follow mode)
docker compose logs -f

# API only (last 100 lines + follow)
docker compose logs -f --tail=100 api

# Postgres only
docker compose logs -f postgres

# Nginx logs
sudo tail -f /var/log/nginx/vocotable_access.log
sudo tail -f /var/log/nginx/vocotable_error.log
```

### Restarting services

```bash
# Restart just the API (zero-downtime for Postgres)
docker compose restart api

# Restart everything
docker compose restart

# Full stop and start
docker compose down
docker compose up -d
```

### Updating code (deploy a new version)

```bash
cd /opt/vocotable

# Pull latest code
git pull origin main

# Rebuild and restart (only rebuilds changed layers)
docker compose up -d --build

# Run any new migrations
docker compose exec api npm run db:migrate:prod

# Verify
curl https://api.vocotable.com/health
```

### Running migrations

```bash
docker compose exec api npm run db:migrate:prod
```

### Manual database backup

```bash
/opt/vocotable/deploy/scripts/backup-postgres.sh
```

### Connecting to the database

```bash
# Interactive psql session
docker compose exec postgres psql -U vocotable -d vocotable

# Run a quick query
docker compose exec postgres psql -U vocotable -d vocotable \
    -c "SELECT count(*) FROM reservations;"
```

### Checking disk usage

```bash
# Overall disk
df -h

# Docker disk usage
docker system df

# Database size
docker compose exec postgres psql -U vocotable -d vocotable \
    -c "SELECT pg_size_pretty(pg_database_size('vocotable'));"
```

### Cleaning up Docker resources

```bash
# Remove unused images, containers, networks
docker system prune -f

# Remove unused volumes (CAREFUL — only if you know what you're doing)
# docker volume prune -f
```

---

## Troubleshooting

### API container won't start

```bash
# Check container logs
docker compose logs api

# Common issues:
# - DATABASE_URL is wrong → check .env
# - Port 3050 already in use → check with: sudo lsof -i :3050
# - Build failed → check Dockerfile syntax
```

### Postgres connection refused

```bash
# Is the Postgres container running?
docker compose ps postgres

# Can the API reach it?
docker compose exec api sh -c "nc -zv postgres 5432"

# Check Postgres logs
docker compose logs postgres
```

### Nginx returns 502 Bad Gateway

```bash
# Is the API container running and healthy?
curl http://localhost:3050/health

# Check Nginx error log
sudo tail -20 /var/log/nginx/vocotable_error.log

# Common cause: API container crashed or isn't listening on port 3050
docker compose ps api
docker compose logs --tail=50 api
```

### SSL certificate issues

```bash
# Check certificate expiry
sudo certbot certificates

# Force renewal
sudo certbot renew --force-renewal

# Reload Nginx after renewal
sudo systemctl reload nginx
```

### Restrict SSH access

For better security, restrict SSH to your IP or use IAP tunneling:

```bash
# Option A: Restrict to your IP
gcloud compute firewall-rules create vocotable-ssh-restricted \
    --direction=INGRESS \
    --priority=900 \
    --network=default \
    --action=ALLOW \
    --rules=tcp:22 \
    --source-ranges=YOUR_IP/32 \
    --target-tags=http-server

# Delete the default SSH rule
gcloud compute firewall-rules delete default-allow-ssh

# Option B: Use IAP tunneling (recommended)
gcloud compute ssh vocotable-api \
    --zone=australia-southeast1-b \
    --tunnel-through-iap
```

### VM ran out of memory

```bash
# Check memory usage
free -h

# Check which process is using the most memory
top -o %MEM

# Options:
# 1. Add swap space
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# 2. Upgrade the VM
# (See Step 1 tip for machine type upgrade commands)
```

### Checking firewall rules

```bash
# List all rules
gcloud compute firewall-rules list

# Test connectivity from outside
nc -zv YOUR_STATIC_IP 443
nc -zv YOUR_STATIC_IP 80
```
