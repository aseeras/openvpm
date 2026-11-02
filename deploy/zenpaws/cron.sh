#!/bin/bash
# Installs the ZenPaws scheduled jobs as systemd timers. Safe to re-run; the
# updater runs it after every update. Each timer calls a local app route with
# the CRON_SECRET from /etc/openvpm.env, sent on stdin so it never appears in
# a process list.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
[ -f /etc/openvpm.env ] || { echo "This is not the ZenPaws OpenVPM server (no /etc/openvpm.env)."; exit 1; }

cat > /usr/local/bin/zenpaws-cron <<'SCRIPT'
#!/bin/bash
# Usage: zenpaws-cron <job>   (calls http://127.0.0.1:3000/api/cron/<job>)
set -euo pipefail
JOB="$1"
[[ "$JOB" =~ ^[a-z-]+$ ]] || { echo "bad job name"; exit 2; }
SECRET=$(sed -n 's/^CRON_SECRET=//p' /etc/openvpm.env | tail -1)
[ -n "$SECRET" ] || { echo "CRON_SECRET is not set; skipping $JOB"; exit 0; }
printf 'Authorization: Bearer %s\n' "$SECRET" |
  curl -fsS --max-time 150 -H @- "http://127.0.0.1:3000/api/cron/$JOB"
echo
SCRIPT
chmod 700 /usr/local/bin/zenpaws-cron

install_job() {
  local job="$1" calendar="$2"
  cat > "/etc/systemd/system/zenpaws-cron-$job.service" <<UNIT
[Unit]
Description=ZenPaws scheduled job: $job
After=openvpm.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/zenpaws-cron $job
UNIT
  cat > "/etc/systemd/system/zenpaws-cron-$job.timer" <<UNIT
[Unit]
Description=Run ZenPaws job $job on schedule

[Timer]
OnCalendar=$calendar
Persistent=true

[Install]
WantedBy=timers.target
UNIT
}

# Morning briefing: hourly; the app sends each person's email once a day at
# the clinic's chosen hour, and only to people turned on in the app.
install_job morning-briefing '*-*-* *:05:00'

systemctl daemon-reload
systemctl enable --now zenpaws-cron-morning-briefing.timer >/dev/null
echo "scheduled jobs: morning-briefing (hourly at :05)"
