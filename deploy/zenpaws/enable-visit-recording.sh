#!/bin/bash
# Turns on consented house-call recording: Amazon Transcribe for the audio and
# Claude for the SOAP draft. Asks for the Anthropic API key without echoing it
# and stores it only in /etc/openvpm.env on this server.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
ENV_FILE=/etc/openvpm.env
[ -f "$ENV_FILE" ] || { echo "This is not the ZenPaws OpenVPM server (no $ENV_FILE). Open Lightsail > zenpaws-vpm > Connect using SSH and run it there."; exit 1; }

MODEL="${1:-claude-sonnet-5-5}"

set_env() {
  local name="$1" value="$2"
  if grep -q "^${name}=" "$ENV_FILE"; then
    # Replace in place without putting the value on a command line.
    awk -v n="$name" -v v="$value" 'BEGIN{FS=OFS="="} $1==n {print n "=" v; next} {print}' "$ENV_FILE" > "$ENV_FILE.tmp"
    cat "$ENV_FILE.tmp" > "$ENV_FILE" && rm -f "$ENV_FILE.tmp"
  else
    printf '%s=%s\n' "$name" "$value" >> "$ENV_FILE"
  fi
}

# REPLACE_KEY=yes asks for a new key even when one is already set.
[ "${REPLACE_KEY:-no}" = "yes" ] && sed -i '/^ANTHROPIC_API_KEY=/d' "$ENV_FILE"
if grep -q '^ANTHROPIC_API_KEY=.\+' "$ENV_FILE"; then
  echo "An Anthropic API key is already set; keeping it."
else
  read -r -s -p "Paste the Anthropic API key (starts with sk-ant-), then press Enter: " KEY
  echo
  case "$KEY" in
    sk-ant-*) ;;
    *) echo "That does not look like an Anthropic API key. Nothing was changed."; exit 1 ;;
  esac
  set_env ANTHROPIC_API_KEY "$KEY"
  unset KEY
fi

set_env AI_MODEL "$MODEL"
set_env VISIT_RECORDING_TRANSCRIPTION aws_transcribe
chmod 640 "$ENV_FILE" && chown root:openvpm "$ENV_FILE"

systemctl restart openvpm
for i in $(seq 1 30); do curl -fsS -o /dev/null http://127.0.0.1:3000/login && break; sleep 2; done
echo "Visit recording is on (AI model: $MODEL). Open a house call in exam and look for 'Record this visit' in the SOAP note."
