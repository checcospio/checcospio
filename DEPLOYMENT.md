# Deployment guide

The application uses a local SQLite database and local file storage. Deploy it only on a host that provides a persistent filesystem mounted at `DATA_DIR`. A free service with an ephemeral filesystem is not safe for this setup: a restart or redeploy can erase the database, sessions and uploads.

## Prepared deployment

The included `Dockerfile` and `docker-compose.yml` run the app with `DATA_DIR=/data`, expose the Node service only on the server's loopback interface, and keep application data in the host's `storage/` directory. Put an HTTPS reverse proxy in front of port `3000`.

## Free option: Oracle Cloud Always Free VM

Oracle documents Always Free compute and block-volume resources, which can run Docker and keep SQLite on a persistent VM disk. Free capacity is not guaranteed in every region, and Oracle may reclaim idle instances; treat this as a low-cost starting point, not an uptime guarantee.

1. Create an OCI account and an Ubuntu VM in the home region. Select an Always Free-eligible shape; assign a public IP and allow inbound `80` and `443` in the network security rules. Restrict SSH (`22`) to your own IP.
2. Install Docker Engine and the Docker Compose plugin using Docker's official instructions for the VM's Ubuntu version.
3. Clone this repository on the VM and enter the project directory.
4. Create `.env` from `.env.example`. Set a unique `SESSION_SECRET` and administrator username/password directly on the VM; never commit `.env` or send its values in chat. Keep `NODE_ENV=production`.
5. Create and grant the container's data directory before starting:

   ```sh
   sudo mkdir -p storage
   sudo chown -R 1000:1000 storage
   ```

6. Start the service with `docker compose up -d --build`.
7. Configure Caddy or another HTTPS reverse proxy for your domain, forwarding to `127.0.0.1:3000`. The app uses secure session cookies in production, so serve it over HTTPS.
8. Verify `https://your-domain.example/api/health` returns `{"ok":true,...}` and `/api/payments/status` reports `checkoutEnabled: false`.
9. Back up `storage/` regularly and test restoring a backup. Do not run multiple app instances against the same SQLite database.

## Alternative: Render

Render can run the included Docker image, but its filesystem is ephemeral by default. Its documentation says persistent disks are available for paid web services, not free services. For a Render deployment, attach a disk mounted at `/var/data` and set `DATA_DIR=/var/data`; do not use the free service for the SQLite-backed application.

## Before public launch

- Add a domain and working HTTPS reverse proxy.
- Set unique production secrets on the host and verify they are not in Git history.
- Confirm persistent storage and backup/restore behavior.
- Review privacy, cookie, newsletter and legal requirements before enabling data collection.
- Keep checkout and payment provider credentials unset until the full purchase and fulfilment flow is implemented and tested.
