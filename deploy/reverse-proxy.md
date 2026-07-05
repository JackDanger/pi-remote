# Reverse-proxy notes

pi-remote binds to localhost and does no auth or TLS. The proxy in front of it must:

1. terminate TLS
2. authenticate every request (mTLS client certs, OAuth proxy, basic auth, or a
   private network)
3. forward WebSocket upgrades on `/ws`
4. allow long-lived connections (agent runs can stream for many minutes)

## Nginx Proxy Manager

Create a Proxy Host:

- **Domain**: your hostname
- **Forward Hostname / IP**: the machine running pi-remote
- **Forward Port**: `3141`
- **Websockets Support**: **ON** (this sets the upgrade headers for you)
- **SSL**: request or supply a certificate; force SSL

For mTLS (client certificates), add to the host's **Advanced** tab, with your CA
uploaded to the NPM host (adjust paths):

```nginx
ssl_client_certificate /data/custom_ssl/client-ca.pem;
ssl_verify_client on;
```

### Hosting under a subpath (e.g. `https://host/pi`)

The frontend uses relative asset URLs and derives its WebSocket URL from
`location.pathname`, so subpath hosting needs the prefix stripped before proxying.
In the host's **Advanced** tab (instead of a Custom Location):

```nginx
location /pi/ {
    proxy_pass http://YOUR_BACKEND:3141/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
location = /pi {
    return 301 /pi/;
}
```

A dedicated subdomain (`pi.example.com` → port 3141) is simpler if you can spare one.

## Raw nginx

```nginx
server {
    listen 443 ssl;
    server_name pi.example.com;

    ssl_certificate     /etc/ssl/your/fullchain.pem;
    ssl_certificate_key /etc/ssl/your/privkey.pem;

    ssl_client_certificate /etc/ssl/your/client-ca.pem;
    ssl_verify_client on;

    location / {
        proxy_pass http://127.0.0.1:3141;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

## Verifying

```bash
curl https://your-host/healthz
```

should return `{"ok":true,"liveSessions":N}` only when your auth requirement is
satisfied (e.g. with the client cert, and 4xx without it).
