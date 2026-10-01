# Automatic deployment

Push to the **`production`** branch and the server installs it by itself.

## How it works

- A small timer on the server runs `scripts/deploy.sh` one minute after the
  server starts and then every 2 minutes.
- If `production` has a new commit, the script pulls it, rebuilds
  (`docker compose up -d --build`) and checks `/health`.
- If the new version does not start, it **goes back to the previous version**
  and will not retry that same commit until a newer one arrives.
- The server only reaches out to GitHub, using a read-only deploy key. Nothing
  is opened to the internet and GitHub holds no keys for your server.
- The server is off 7 PM to 6 AM. A push made at night is installed about a
  minute after the 6 AM start.
- GitHub also runs **Check backend** on every push to `production` (a syntax
  check). A red cross there means a broken file, but it does not stop the
  server from updating, so check it after you push.

## One-time setup

### 1. On your PC, in the backend folder

```
git add .github scripts/deploy.sh scripts/install-auto-deploy.sh DEPLOY-AUTOMATION.md
git commit -m "Automatic deployment"
git push
git checkout -b production
git push -u origin production
git checkout main
```

Do not use `git add -A` here: your folder has files that must not go to GitHub
(for example `test-parent-logins.csv`).

### 2. On the server: let it read the (private) repository

The repository is private, so the server needs its own **read-only** key.
It can only read this one repository, and it cannot change anything on GitHub.

```
ssh -i your-key.pem ubuntu@<your-elastic-ip>
ssh-keygen -t ed25519 -f ~/.ssh/evide_deploy_key -N "" -C "school-bus-server"
cat ~/.ssh/evide_deploy_key.pub
```

Copy the line that starts with `ssh-ed25519`. On GitHub open the repository
**Settings > Deploy keys > Add deploy key**, paste it, title it `AWS server`,
leave **Allow write access UNTICKED**, and save.

Back on the server:

```
cat >> ~/.ssh/config <<'CONFIG'
Host github.com
  HostName github.com
  User git
  IdentityFile ~/.ssh/evide_deploy_key
  IdentitiesOnly yes
CONFIG
chmod 600 ~/.ssh/config
ssh -T -o StrictHostKeyChecking=accept-new git@github.com
```

The last command should say `Hi Evide-AI/Evide_schoolbus_backend! You've
successfully authenticated`. That is the sign it works.

### 3. On the server: make sure it is a git clone on the production branch

```
cd ~/school-bus-backend
git remote -v
```

**If it prints a GitHub address**, point it at the key and switch branch:

```
git remote set-url origin git@github.com:Evide-AI/Evide_schoolbus_backend.git
git fetch origin
git checkout production
git pull
```

**If it says "not a git repository"**, the folder was copied up by hand. Replace
it with a clone and keep your private files:

```
cd ~/school-bus-backend && docker compose down && cd ~
mv school-bus-backend school-bus-backend-old
git clone -b production git@github.com:Evide-AI/Evide_schoolbus_backend.git school-bus-backend
cp school-bus-backend-old/.env school-bus-backend/.env
cp -r school-bus-backend-old/secrets school-bus-backend/secrets
cd school-bus-backend
docker compose up -d --build
```

The TLS certificate is kept in a Docker volume, so HTTPS comes back by itself.
Keep `school-bus-backend-old` for a few days, then delete it.

### 4. On the server: install the timer (once)

```
cd ~/school-bus-backend
bash scripts/install-auto-deploy.sh
```

If it says your user is not in the `docker` group, run the command it prints,
log out, log in again and re-run it.

### 5. Check it

```
systemctl list-timers evide-auto-deploy.timer
journalctl -u evide-auto-deploy -n 50 --no-pager
curl https://school.evide.in/health
```

## Everyday use

```
git checkout production
git merge main
git push
git checkout main
```

Within about 2 minutes the server runs the new version. To see what happened:

```
journalctl -u evide-auto-deploy -n 50 --no-pager
```

You will see `Deployed abc1234. Backend is healthy.`, or a rollback message.

## If the server has edits that are not in GitHub

Do not edit code directly on the server. If you do, the deploy script stops
(it will not overwrite them) and prints the changed files in
`journalctl -u evide-auto-deploy`. Fix it one of two ways:

- Keep the change: make the same edit on your PC, commit, push to `production`,
  then on the server run `git checkout -- .` so the server copy matches GitHub.
- Drop the change: run `DEPLOY_DISCARD_LOCAL=1 bash scripts/deploy.sh`. It saves
  the edits to `/var/tmp/evide-server-edits-<time>.patch` first, then continues.

## Good to know

- **Database changes are not automatic.** If a release needs a Supabase
  migration, run it in the SQL editor **before** you push.
- **Server settings** (`.env`, `secrets/`) live only on the server and are never
  touched by a deploy.
- **Never commit passwords, keys or `.env`**, even though the repository is private.
- **Roll back a bad release**: undo it on GitHub (`git revert <commit>` on the
  production branch, then push). The server follows within minutes.
- **Try a failed version again**: `FORCE=1 bash scripts/deploy.sh` on the server.
- **Pause automatic deploys**: `sudo systemctl disable --now evide-auto-deploy.timer`
  (turn back on with `sudo systemctl enable --now evide-auto-deploy.timer`).
- **Safer releases**: in GitHub, Settings > Branches, protect `production` and
  require a pull request and the **Check backend** check before merging.
