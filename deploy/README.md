# Deploying on a VPS

## Requirements

- Docker + Docker Compose installed on the VPS
- Port 80 and 443 open in your firewall
- A domain name pointed at your VPS IP (required for HTTPS)

## Steps

**1. Clone and configure**
```bash
git clone <repo-url>
cd <repo>
cp .env.example .env
# Set OPENAI_API_KEY in .env
```

**2. Start the app**
```bash
docker compose up -d
```

The app is now reachable on port 3000. Do not expose this port publicly — put Nginx in front.

**3. Set up Nginx**
```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/paodo
sudo ln -s /etc/nginx/sites-available/paodo /etc/nginx/sites-enabled/paodo

# Edit the file and replace server_name _ with your actual domain
sudo nano /etc/nginx/sites-available/paodo

sudo nginx -t && sudo systemctl reload nginx
```

**4. Enable HTTPS**
```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

Certbot rewrites the Nginx config automatically and sets up auto-renewal.

## Security notes

- **Add authentication.** The app has no login system. Until you add one, restrict access with Nginx basic auth or a VPN.
- **API keys travel over the wire unencrypted without HTTPS.** Complete step 4 before using API access.
- **The Docker socket is mounted** (`/var/run/docker.sock`). This gives the app container full Docker access on the host — keep the VPS access tightly controlled.
