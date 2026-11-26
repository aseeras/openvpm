#!/bin/bash
# Puts the ZenPaws app demo video in Settings > Videos, the admin-only page of
# the staff app, so the team can watch it there instead of on the public site.
#
#   sudo bash set-staff-videos.sh          # add it (safe to re-run)
#   sudo bash set-staff-videos.sh --show   # only list what is set now
#
# The video file itself stays where it is hosted (the website's media folder);
# the app keeps only the link. Videos can be added or removed later in
# Settings > Videos.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
[ -f /root/zenpaws-admin.env ] || { echo "Run set-db-admin.sh first (no /root/zenpaws-admin.env)."; exit 1; }
. /root/zenpaws-admin.env
SITE="${SITE:-https://zenpawsdvm.com}"
PSQL=(psql "$MASTER_URL" -v ON_ERROR_STOP=1 -Atq)

PRACTICE=$("${PSQL[@]}" -c "select id from practices where deleted_at is null order by created_at limit 1")
[ -n "$PRACTICE" ] || { echo "No practice found. Nothing was changed."; exit 1; }

show() {
  echo "Videos in Settings > Videos:"
  "${PSQL[@]}" -c "select '  - ' || (v->>'title') || '  ' || (v->>'url') from practices p cross join lateral jsonb_array_elements(coalesce(p.settings->'staffVideos', '[]'::jsonb)) v where p.id = '$PRACTICE'"
}

if [ "${1:-}" = "--show" ]; then show; exit 0; fi

"${PSQL[@]}" -v practice="$PRACTICE" -v site="$SITE" <<'SQL'
with video as (
  select jsonb_build_object(
    'title', 'ZenPaws app demo: a recheck from the couch',
    'url', :'site' || '/media/zenpaws-app-demo.mp4',
    'posterUrl', :'site' || '/media/zenpaws-app-demo-poster.jpg',
    'note', 'A pet owner starts a video visit, Dr. Blake runs the recheck, and the visit summary and records appear in the app. Sample data.'
  ) as v
)
update practices p
set settings = coalesce(p.settings, '{}'::jsonb) || jsonb_build_object(
      'staffVideos',
      coalesce(p.settings->'staffVideos', '[]'::jsonb) || jsonb_build_array(video.v)
    ),
    updated_at = now()
from video
where p.id = :'practice'
  and not exists (
    select 1 from jsonb_array_elements(coalesce(p.settings->'staffVideos', '[]'::jsonb)) e
    where e->>'url' = video.v->>'url'
  );
SQL

show
echo "Open: https://${ZENPAWS_DOMAIN:-app.zenpawsdvm.com}/settings?tab=videos"
