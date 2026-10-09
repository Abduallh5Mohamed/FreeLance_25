# Web Multi-DRM activation

The application is wired to VdoCipher for managed Widevine/FairPlay delivery.
The API secret must only exist in `server/.env` and must never use a `VITE_`
prefix.

```env
VIDEO_DRM_REQUIRED=true
VIDEO_DRM_PROVIDER=vdocipher
VDOCIPHER_API_SECRET=replace_with_the_account_api_secret
VDOCIPHER_FOLDER_ID=root
VDOCIPHER_API_BASE=https://dev.vdocipher.com/api
```

Apply these migrations before enabling the flag:

1. `server/migrations/20260925_web_multidrm.sql`
2. `server/migrations/20260925_web_multidrm_preview.sql`

Reload the API process after changing the environment. An authenticated request
to `GET /api/videos/drm/status` must then return:

```json
{"required":true,"provider":"vdocipher","configured":true}
```

New uploads are sent to the DRM provider and to a temporary private processing
object. The private copy is used only to produce the separate first-ten-minute
DRM preview and is deleted after processing.

Existing MinIO videos are legacy clear/AES-HLS assets. They must be re-uploaded
through the instructor uploader. When `VIDEO_DRM_REQUIRED=true`, the server
rejects playback of these legacy assets instead of silently falling back to an
unprotected stream.

Production must use HTTPS. Keep `player.vdocipher.com` in `frame-src` and in the
`encrypted-media` Permissions Policy as configured in `nginx-hardened-v4.conf`.
