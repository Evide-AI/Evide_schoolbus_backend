# Backend Deployment Guide — EC2 + Docker + Caddy (HTTPS)

Deploys the Node backend (GT06 ingestion + API + workers + FCM) to your Ubuntu
EC2, behind `school.evide.in` with automatic HTTPS. Follow top to bottom.

---

## 0. Before you start — have these ready

- EC2 running (Ubuntu, Elastic IP attached). You have this.
- Your domain's DNS control panel (to add the subdomain record).
- Firebase **service-account key** JSON file (downloaded). Do NOT commit it.
- Your Supabase `DATABASE_URL` (session pooler string), `SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY`, and `MAPBOX_ACCESS_TOKEN`.

---

## 1. Point the subdomain at the server (DNS)

In your domain registrar / DNS panel, add an **A record**:

```
Type: A
Name: school            (this makes school.evide.in)
Value: <your EC2 Elastic IP>
TTL: default
```

Wait a few minutes for it to propagate. Test from your laptop:
`ping school.evide.in` should show your Elastic IP.

---

## 2. Open the required ports (EC2 Security Group)

In the AWS console → EC2 → your instance → Security → the attached security
group → Inbound rules → add:

| Type       | Protocol | Port | Source        | Why                          |
|------------|----------|------|---------------|------------------------------|
| Custom TCP | TCP      | 5023 | 0.0.0.0/0     | GT06 devices connect here    |
| HTTP       | TCP      | 80   | 0.0.0.0/0     | Let's Encrypt cert challenge |
| HTTPS      | TCP      | 443  | 0.0.0.0/0     | API over HTTPS               |
| SSH        | TCP      | 22   | My IP only    | Your admin access            |

---

## 3. Install Docker on the EC2

SSH into the instance, then:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo usermod -aG docker $USER
# log out and back in (or run: newgrp docker) so docker works without sudo
```

Verify: `docker --version` and `docker compose version`.

---

## 4. Get the code onto the server

Either `git clone` your backend repo, or copy the project up with `scp`. You
want the whole `school-bus-backend` folder on the server, e.g. at
`~/school-bus-backend`.

```bash
cd ~/school-bus-backend
```

---

## 5. Configure secrets and env

```bash
# 5a. Create the .env from the template and fill in real values
cp .env.example .env
nano .env
```
Set: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL` (session
pooler), `MAPBOX_ACCESS_TOKEN`, and leave `FIREBASE_SERVICE_ACCOUNT` as
`/app/secrets/serviceAccountKey.json` (that's the in-container path). Optionally
set `ALLOWED_ORIGINS` to your dashboard's URL.

```bash
# 5b. Put the Firebase key where docker-compose expects it
mkdir -p secrets
nano secrets/serviceAccountKey.json   # paste the downloaded JSON, save
```

The `.env` and `secrets/` are gitignored — they live only on the server.

---

## 6. Confirm the Caddyfile domain

`Caddyfile` already says `school.evide.in`. If you ever change the subdomain,
edit it here too.

---

## 7. Build and start

```bash
docker compose up -d --build
```

This builds the backend image, starts it + Caddy, and Caddy automatically
fetches the HTTPS certificate for `school.evide.in` (needs steps 1 and 2 done
first). Check it's up:

```bash
docker compose ps          # both 'backend' and 'caddy' should be Up
docker compose logs -f backend
```

You should see:
```
[GT06] TCP server listening on 0.0.0.0:5023 (all interfaces)
[API] Express server listening on port 3000
[pg-boss] queue started
[FCM] Firebase Admin initialized — push notifications enabled.
```
(If FCM says "not configured", the key path/file is wrong — recheck step 5b.)

---

## 8. Verify the API over HTTPS

From your laptop:
```bash
curl https://school.evide.in/health
```
Should return `{"ok":true,...}`. If the certificate isn't ready yet, give Caddy
a minute and check `docker compose logs caddy` for the cert-issued line.

---

## 9. Run the database migrations (once)

In the Supabase SQL editor, run any migrations you haven't yet, in order:
`migration_002` … `migration_005`. Or run the full latest `src/db/schema.sql`
on a fresh project. Without these the apps' newer features (attendance, photos,
device tokens, driver notifications) won't work.

---

## 10. Point the dashboard at the API

In the management dashboard's env (wherever you host it), set:
```
VITE_API_BASE_URL=https://school.evide.in
```
Rebuild/redeploy the dashboard. Now when you add a student to a bus, the
dashboard calls the API to generate that bus's route.

---

## 11. Set up the daily on/off schedule (cost saving)

You want the instance to run only ~6am–7pm IST. This is done in AWS, not in the
app. Two options:

**Simple (EventBridge Scheduler):**
- AWS Console → Amazon EventBridge → Scheduler → Create schedule.
- Schedule 1 — **Start**: cron `0 6 * * ? *`, timezone Asia/Kolkata, target
  = EC2 `StartInstances` with your instance ID.
- Schedule 2 — **Stop**: cron `0 19 * * ? *`, timezone Asia/Kolkata, target
  = EC2 `StopInstances` with your instance ID.
- Give the schedule an IAM role allowing `ec2:StartInstances` /
  `ec2:StopInstances`.

Because docker-compose uses `restart: always`, the backend comes back up
automatically every morning when the instance powers on. Nothing to do on the
app side.

Notes:
- Tracking (GT06 + parent app live updates) is off while the instance is
  stopped. Fine for an MVP with no night runs.
- The Elastic IP stays reserved (a small hourly charge applies while the
  instance is stopped — minor).

---

## Updating the backend later

```bash
cd ~/school-bus-backend
git pull            # or re-copy files
docker compose up -d --build
```

## Enabling AIS-140 later

The AIS-140 (ROADRPA) parser is already in the code (`src/gt06/roadrpa.js`) and
wired into the TCP server — it auto-detects AIS-140 sentences vs GT06 binary on
the same port 5023. When you install AIS-140 devices, point them at
`school.evide.in:5023` (or the Elastic IP:5023) and they'll be parsed with no
code change. Just make sure each device's IMEI is registered on a bus in the
dashboard.

## Common issues

- **Cert not issued / HTTPS fails**: DNS A-record not propagated, or port 80
  blocked. Fix step 1/2, then `docker compose restart caddy`.
- **FCM "not configured"**: `secrets/serviceAccountKey.json` missing or invalid
  JSON. Recheck step 5b.
- **API works but dashboard can't call it**: CORS — set `ALLOWED_ORIGINS` in
  `.env` to your dashboard origin, then `docker compose up -d`.
- **GT06 device not connecting**: security group port 5023 not open, or device
  pointed at the wrong IP/port.
